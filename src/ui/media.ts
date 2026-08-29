// Turning whatever the file picker gave us into something every platform can
// display.
//
// ---------------------------------------------------------------------------
// Why a photo cannot just be uploaded as picked
// ---------------------------------------------------------------------------
//
// The three targets disagree about what a photo is.
//
// An iPhone's camera roll is HEIC. Safari decodes it; Chrome and Firefox do
// not. Upload one unchanged and it arrives as a broken image on every Android
// phone and desktop in the conversation, while looking perfect to the person
// who sent it -- the worst shape of bug, invisible to the only person who
// could report it.
//
// Android and desktop hand over JPEG or PNG, which everyone can read, but at
// whatever the sensor produced: a recent phone photo is 12 megapixels and
// several megabytes, sent to be looked at in a bubble a few hundred pixels
// wide.
//
// So everything is decoded and re-encoded to JPEG at a sane size before it
// leaves. HEIC decodes on the only platform that produces it, which is what
// makes this work at all.
//
// Two useful things fall out of re-encoding. EXIF is dropped, and EXIF on a
// phone photo usually contains the GPS coordinates it was taken at -- sending
// those to everyone in a conversation is not something anybody intends. And
// orientation is baked into the pixels, so a photo taken sideways is not
// displayed sideways by whichever browser ignores the EXIF flag.

/** The longest edge a photo is stored at. */
const MAX_EDGE = 2048;

/** JPEG quality. 0.82 is the usual point where artefacts stop being visible. */
const QUALITY = 0.82;

export type PreparedFile = {
  bytes: Uint8Array;
  mediaType: string;
  width?: number;
  height?: number;
};

export type PrepareError = { kind: "unsupported" | "too-large"; message: string };

/**
 * Prepares a picked file for upload.
 *
 * Images are re-encoded; anything else is passed through untouched, because
 * re-encoding a PDF is not a thing that means anything. `maxBytes` is the
 * caller's limit from the server, checked here so somebody learns their file
 * is too big before waiting for an upload to fail.
 */
export async function prepareForUpload(
  file: File,
  maxBytes: number,
): Promise<PreparedFile | PrepareError> {
  if (!file.type.startsWith("image/")) {
    if (file.size > maxBytes) {
      return { kind: "too-large", message: "That file is too large to send." };
    }
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType: file.type || "application/octet-stream",
    };
  }

  const reencoded = await reencode(file);

  // A GIF re-encoded to JPEG is a still frame, which is not what anybody meant
  // by sending a GIF, so it is left alone -- and animation is exactly why it
  // might be too large, hence the check.
  const keepOriginal = file.type === "image/gif";
  const chosen = keepOriginal || !reencoded ? null : reencoded;

  if (!chosen) {
    if (file.size > maxBytes) {
      return {
        kind: "too-large",
        message: "That image is too large to send.",
      };
    }
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType: file.type,
    };
  }

  if (chosen.bytes.byteLength > maxBytes) {
    return { kind: "too-large", message: "That image is too large to send." };
  }

  return chosen;
}

/**
 * Decodes and re-encodes to JPEG, or returns null if this browser cannot.
 *
 * Null rather than throwing: a decode failure means the format is not readable
 * here, and the caller's fallback -- send the original bytes -- is the right
 * answer rather than an error. That is also the honest outcome for a HEIC
 * picked on a browser that cannot read one, which should not happen, since the
 * only platform that produces them can read them.
 */
async function reencode(file: File): Promise<PreparedFile | null> {
  try {
    // `imageOrientation: "from-image"` applies the EXIF rotation while
    // decoding, so the pixels come out the way up the photo was taken. Without
    // it the orientation flag is dropped by the re-encode and every portrait
    // photo from a phone arrives on its side.
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });

    const scale = Math.min(
      1,
      MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null;
    }

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", QUALITY);
    });

    if (!blob) return null;

    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mediaType: "image/jpeg",
      width,
      height,
    };
  } catch {
    return null;
  }
}

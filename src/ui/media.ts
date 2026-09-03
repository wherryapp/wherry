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

  // A GIF re-encoded to JPEG is a still frame, which is not what anybody meant
  // by sending a GIF, so it is left alone -- and animation is exactly why it
  // might be too large, hence the check. Decided before the re-encode rather
  // than after: this used to re-encode every GIF and then discard the result,
  // which is a full decode and JPEG pass spent on nothing.
  const keepOriginal = file.type === "image/gif";
  const chosen = keepOriginal ? null : await reencode(file);

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
      // Measured even though nothing is being re-encoded, because the
      // dimensions are not decoration: they are what lets the bubble reserve
      // the right box before the bytes arrive. Without them the placeholder
      // is sized against the wrong width and the timeline moves when the real
      // image lands -- the `aspect-ratio` sharp edge in CLAUDE.md, and one of
      // the three causes already found behind "a conversation opens
      // mid-thread". Every GIF ever sent went out without them; that was
      // survivable while GIFs were rare and is not now that a picker makes
      // them ordinary.
      ...((await intrinsicSize(file)) ?? {}),
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
/** A profile picture's stored edge. Drawn at 56px at the largest today, so
 *  256 covers a 3x display and a bigger card later without a re-upload. */
const AVATAR_EDGE = 256;

/** A touch above the photo quality: a face at 256px has nowhere to hide a
 *  compression artefact, and the whole file is still about 20 KB. */
const AVATAR_QUALITY = 0.85;

/** The server's limit (routes/account.ts). Checked here so somebody is told
 *  before an upload rather than by a 413 after one -- and in practice
 *  unreachable, since a 256x256 JPEG is two orders of magnitude below it. */
const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * Prepares a picked file as a profile picture: centre-cropped square, 256px,
 * JPEG.
 *
 * Square and JPEG rather than "whatever they picked", for two reasons that
 * are not aesthetic. Every avatar in the app is a circle, so a picture that
 * is not square is going to be cropped by *something* -- doing it here means
 * the person sees the result before it is published, rather than discovering
 * that CSS took the top-left corner of their photo. And the server serves
 * these bytes back under `content-type: image/jpeg` and refuses anything
 * that is not one (services/image-sniff.ts), so producing a JPEG is the
 * client's half of that contract.
 *
 * Centre crop rather than a face detector or a chooser: it is what people
 * expect, it is what every other app does, and the alternative is a cropping
 * UI, which is a feature rather than a detail.
 */
export async function prepareAvatar(
  file: File,
): Promise<{ bytes: Uint8Array } | PrepareError> {
  if (!file.type.startsWith("image/")) {
    return {
      kind: "unsupported",
      message: "Choose an image for your profile picture.",
    };
  }

  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });

    // The largest centred square the picture contains.
    const edge = Math.min(bitmap.width, bitmap.height);
    const sx = Math.round((bitmap.width - edge) / 2);
    const sy = Math.round((bitmap.height - edge) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EDGE;
    canvas.height = AVATAR_EDGE;

    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return { kind: "unsupported", message: "That image could not be read." };
    }

    context.drawImage(bitmap, sx, sy, edge, edge, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", AVATAR_QUALITY);
    });

    if (!blob) {
      return { kind: "unsupported", message: "That image could not be read." };
    }

    if (blob.size > AVATAR_MAX_BYTES) {
      return {
        kind: "too-large",
        message: "That picture is too large. Try a smaller one.",
      };
    }

    return { bytes: new Uint8Array(await blob.arrayBuffer()) };
  } catch {
    // The same honest failure as reencode's: an unreadable image, or a HEIC
    // on a browser that cannot decode one. There is no passthrough fallback
    // here -- the server would refuse a non-JPEG, correctly.
    return { kind: "unsupported", message: "That image could not be read." };
  }
}

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

/**
 * The pixel size of an image without re-encoding it.
 *
 * For an animated GIF this decodes the first frame, which is the size every
 * frame is. Null on failure, so an unreadable image still sends -- the
 * dimensions are an optimisation for the placeholder, never a precondition
 * for the attachment.
 *
 * `imageOrientation: "from-image"` to match how an `<img>` will display it:
 * CSS `image-orientation` defaults to `from-image`, so a photo carrying an
 * EXIF rotation is shown rotated, with its width and height swapped relative
 * to the stored pixels. Reporting the unrotated pair here would describe a
 * box the browser is never going to draw. GIFs carry no orientation, so this
 * only matters on the fallback path where a re-encode failed.
 */
async function intrinsicSize(
  file: File,
): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

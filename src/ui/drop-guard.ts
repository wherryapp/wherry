// Stops a stray file drop from navigating the app away.
//
// The browser's default action for a file dropped on a page is to *open
// that file*, replacing the document with it. That has always been true
// here; it only stops being theoretical now that the composer invites the
// gesture, because a drop that misses the window's one drop target lands
// on this default instead -- and in the desktop app, where there is no
// address bar and no Back, the app is simply gone until it is restarted.
//
// So the guard is unconditional and app-wide, installed at startup beside
// lockPageZoom for the same reason that one is: the gesture it cancels is
// available from the first frame, and there is no moment at which allowing
// it would be correct.
//
// It is also what makes the composer's own handling possible at all. A
// drop event only fires where the dragover before it was cancelled, so
// cancelling here is the thing that turns the whole window into a drop
// target; the composer then adds its own listeners on top and, running
// second, is the one that decides the drop actually means something. The
// default effect set here is "none" -- with no composer mounted, or with
// the pointer over a part of the app that takes no files, the cursor
// should say so rather than promise a copy that will not happen.

import { transferHasFiles } from "./attach-intake";

export function guardStrayFileDrops(): void {
  const over = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer?.types)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };

  const drop = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer?.types)) return;
    event.preventDefault();
  };

  window.addEventListener("dragover", over);
  window.addEventListener("drop", drop);
}

// Service worker registration.
//
// Separate from the push code that will use it, because registering is the
// part that has to happen on every load regardless of whether anyone has
// granted notification permission. The worker itself is `public/sw.js`, which
// explains what it does and why it deliberately does not cache.

/**
 * Registers the service worker, if this browser has one and the page is in a
 * secure context.
 *
 * Failure is not worth surfacing. Nothing in the app depends on the worker
 * except notifications, and a browser that cannot register one also cannot
 * receive them -- so the honest place to tell somebody is the notification
 * setting, when they ask for it, rather than an error on a page they are
 * trying to read messages on.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (error) {
    console.warn("service worker did not register", error);
  }
}

/**
 * Whether this looks like an installed app rather than a browser tab.
 *
 * iOS only delivers push to a site added to the home screen, so this is the
 * difference between "you can turn notifications on" and "you have to install
 * it first", which is a thing the UI has to be able to say.
 *
 * Two checks because iOS has never supported the standard one: Safari sets the
 * non-standard `navigator.standalone` instead, and it is exactly the platform
 * where the answer matters most.
 */
export function isInstalled(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;

  const iosStandalone = (navigator as { standalone?: boolean }).standalone;
  return iosStandalone === true;
}

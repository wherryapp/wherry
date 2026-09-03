package app.wherry

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * HAND-EDITED. `tauri android init` regenerates this file as the two-line
 * class it started as; the keyboard block below has to be put back if that
 * is ever re-run. See docs/prompts/regen-hand-edits.md and the Android
 * section of docs/mobile-setup.md.
 *
 * The edit exists because an edge-to-edge window is never resized for the
 * keyboard. `enableEdgeToEdge()` is what lets the app draw under the status
 * bar -- which is what makes `env(safe-area-inset-top)` non-zero and the
 * app look native -- and its price, since Android 15, is that the system
 * stops moving the window out of the IME's way and hands the app the
 * insets to deal with instead. Nothing in the web layer can compensate:
 * with the webview never resized, `visualViewport.height` does not change,
 * so `ui/viewport.ts` sees no keyboard, `--app-height` stays the full
 * screen, and the composer sits underneath the keyboard -- invisible, with
 * the send button unreachable. Every text field in the app was affected,
 * sign-in included.
 *
 * Padding the webview by the IME inset is the standard recipe and it puts
 * the web layer back in charge: the webview shrinks, `visualViewport`
 * reports it, and the same code that already handles the iPhone keyboard
 * handles this one.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // The listener goes on the activity's content frame, NOT on the webview.
    // The webview keeps an inset listener of its own -- it is what turns the
    // display cutout into `env(safe-area-inset-*)` for the page -- and
    // setOnApplyWindowInsetsListener replaces a view's listener rather than
    // adding to it, so attaching here left every inset reading 0 and put the
    // header under the status bar. Measured, twice: chaining with
    // ViewCompat.onApplyWindowInsets did not bring it back either, because
    // what was replaced was a listener and not the View method.
    //
    // Padding the parent insets the webview just the same, and leaves the
    // insets untouched on the way down to it.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      // The keyboard replaces the navigation bar rather than stacking on it,
      // so the bottom is the larger of the two, never the sum.
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      insets
    }
  }
}

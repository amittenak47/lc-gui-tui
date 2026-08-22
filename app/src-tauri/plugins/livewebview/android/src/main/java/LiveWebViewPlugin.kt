package dev.lc.whiteboard.livewebview

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The child web view wry will not give Android.
 *
 * Two of them, told apart by label, because they are different things:
 *
 *  - **the live pane** — over the app, at the rectangle the HTML layout
 *    reserved, following it through a sash drag and a rotation, hidden when
 *    its tab is parked;
 *  - **the offscreen render** — behind the app, at the size a page should be
 *    laid out at, alive only long enough to be serialised.
 *
 * Both are `android.webkit.WebView` added to the activity's **decor view**,
 * not to `android.R.id.content`. That is deliberate: `GestureGuardPlugin`
 * finds "the Tauri WebView" by walking down from `content` and taking the
 * first WebView it meets, and a second one parked under there would be found
 * instead — the back-gesture strips would then be measured against the wrong
 * view. Decor view is one level up, so neither plugin can see the other's
 * views, and it is a `FrameLayout` either way.
 *
 * The offscreen render goes in at index 0, under `content`, rather than the
 * `GONE` + 1x1 that the wry path faked with `y: 10_000`. A `GONE` view is not
 * laid out at all, so the page would render into a zero-size viewport and
 * serialise as a column of nothing; a 1x1 one is worse, because the page
 * believes it. Under an opaque app the view is equally invisible and still
 * lays out, paints and runs script at the size asked for, which is the whole
 * point of rendering it.
 */
@TauriPlugin
class LiveWebViewPlugin(private val activity: Activity) : Plugin(activity) {

    /** Open views by label. Insertion-ordered so teardown is predictable. */
    private val views = LinkedHashMap<String, WebView>()

    /**
     * The labels that are in front of the app rather than behind it.
     *
     * Only these take Back. Nothing currently calls `show` on the offscreen
     * render, but "the view nobody can see is eating the back gesture" is a
     * bug worth being unable to write rather than one worth remembering not to.
     */
    private val inFront = HashSet<String>()

    /** The Tauri WebView, found once — before any of ours can confuse it. */
    private var appWebView: WebView? = null

    private var backCallback: OnBackInvokedCallback? = null
    private var backLabel: String? = null

    @InvokeArg
    class CreateArgs {
        var label: String = ""
        var url: String = ""
        var rect: RectArg = RectArg()

        /** CSS px to device px (`window.devicePixelRatio`). */
        var density: Double = 1.0
        var userAgent: String? = null

        /** Behind the app rather than over it — the offscreen render. */
        var behind: Boolean = false
    }

    @InvokeArg
    class PlaceArgs {
        var label: String = ""
        var rect: RectArg = RectArg()
        var density: Double = 1.0
    }

    @InvokeArg
    class ShowArgs {
        var label: String = ""
        var visible: Boolean = true
    }

    @InvokeArg
    class LabelArgs {
        var label: String = ""
    }

    @InvokeArg
    class EvalArgs {
        var label: String = ""
        var script: String = ""
    }

    @InvokeArg
    class RectArg {
        var x: Double = 0.0
        var y: Double = 0.0
        var width: Double = 0.0
        var height: Double = 0.0
    }

    @Command
    fun create(invoke: Invoke) {
        val args = invoke.parseArgs(CreateArgs::class.java)
        activity.runOnUiThread {
            val parent = decor()
            if (parent == null) {
                invoke.reject("no decor view")
                return@runOnUiThread
            }
            // Find the app's own WebView before adding ours, so the origin the
            // rectangle is measured against is never one of these.
            rememberAppWebView()
            destroy(args.label)
            val view = WebView(activity)
            try {
                configure(view, args.label, args.userAgent, args.behind)
                val params = layoutFor(args.rect, args.density, parent)
                if (args.behind) {
                    // Under `content`: invisible behind an opaque app, still
                    // laid out and still running.
                    parent.addView(view, 0, params)
                } else {
                    parent.addView(view, params)
                }
                views[args.label] = view
                if (args.behind) inFront.remove(args.label) else inFront.add(args.label)
                view.loadUrl(args.url)
                if (!args.behind) {
                    view.setOnKeyListener { _, keyCode, event -> onKey(args.label, keyCode, event) }
                    registerBack(args.label)
                }
                invoke.resolve(ok())
            } catch (err: Throwable) {
                // Built but never entered `views`, so `destroy` cannot reach it
                // and the next create would not replace it. A WebView holds a
                // renderer process; leaking one per failed open is not free.
                views.remove(args.label)
                inFront.remove(args.label)
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                invoke.reject(err.message ?: "could not open a web view")
            }
        }
    }

    @Command
    fun place(invoke: Invoke) {
        val args = invoke.parseArgs(PlaceArgs::class.java)
        activity.runOnUiThread {
            val view = views[args.label]
            val parent = view?.parent as? ViewGroup
            if (view == null || parent == null) {
                // A pane can ask before its view is open, or after the address
                // it was on closed one. Neither is a failure.
                invoke.resolve(ok())
                return@runOnUiThread
            }
            view.layoutParams = layoutFor(args.rect, args.density, parent)
            view.requestLayout()
            invoke.resolve(ok())
        }
    }

    @Command
    fun show(invoke: Invoke) {
        val args = invoke.parseArgs(ShowArgs::class.java)
        activity.runOnUiThread {
            val view = views[args.label]
            if (view == null) {
                invoke.resolve(ok())
                return@runOnUiThread
            }
            view.visibility = if (args.visible) View.VISIBLE else View.GONE
            // A hidden pane must not still be eating Back.
            if (args.visible && inFront.contains(args.label)) registerBack(args.label)
            else unregisterBack(args.label)
            invoke.resolve(ok())
        }
    }

    @Command
    fun close(invoke: Invoke) {
        val args = invoke.parseArgs(LabelArgs::class.java)
        activity.runOnUiThread {
            destroy(args.label)
            invoke.resolve(ok())
        }
    }

    @Command
    fun exists(invoke: Invoke) {
        val args = invoke.parseArgs(LabelArgs::class.java)
        activity.runOnUiThread {
            invoke.resolve(JSObject().apply { put("exists", views.containsKey(args.label)) })
        }
    }

    /**
     * Run a script in the page and hand back the JSON encoding of its value.
     *
     * `evaluateJavascript` already answers in JSON, which is the same contract
     * wry's `eval_with_callback` has — so the caller parses one string either
     * way and the serializer needs no Android branch.
     *
     * The timeout matters more than it looks. A `ValueCallback` that never
     * fires — a page that navigated away mid-eval, a renderer that died —
     * would otherwise leave the Rust side blocked on a channel forever, and
     * that thread is the one Freeze is waiting on.
     */
    @Command
    fun eval(invoke: Invoke) {
        val args = invoke.parseArgs(EvalArgs::class.java)
        activity.runOnUiThread {
            val view = views[args.label]
            if (view == null) {
                invoke.reject("no webview named ${args.label}")
                return@runOnUiThread
            }
            val settled = AtomicBoolean(false)
            val handler = Handler(Looper.getMainLooper())
            val expire = Runnable {
                if (settled.compareAndSet(false, true)) invoke.reject("the page script did not return")
            }
            handler.postDelayed(expire, EVAL_TIMEOUT_MS)
            try {
                view.evaluateJavascript(args.script) { value ->
                    if (settled.compareAndSet(false, true)) {
                        handler.removeCallbacks(expire)
                        invoke.resolve(JSObject().apply { put("value", value ?: "null") })
                    }
                }
            } catch (err: Throwable) {
                if (settled.compareAndSet(false, true)) {
                    handler.removeCallbacks(expire)
                    invoke.reject(err.message ?: "the page script could not run")
                }
            }
        }
    }

    // ---- views -------------------------------------------------------------

    private fun ok(): JSObject = JSObject().apply { put("ok", true) }

    private fun decor(): ViewGroup? = activity.window?.decorView as? ViewGroup

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView, label: String, userAgent: String?, behind: Boolean) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            /*
             * Viewport equals the view, the way a wry child webview behaves.
             *
             * With `useWideViewPort` on, a page without a viewport meta tag is
             * laid out at Android's 980px default and then scaled — so the
             * offscreen render would serialise a document whose widths have
             * nothing to do with the size it was asked for, and the live pane
             * would open every desktop page shrunk. Off, the CSS viewport is
             * the rectangle, which is what both callers already assume.
             */
            useWideViewPort = false
            loadWithOverviewMode = false
            if (!userAgent.isNullOrBlank()) userAgentString = userAgent
        }
        /*
         * Without a client of its own a WebView hands every navigation to
         * whatever browser the device uses — so the first link tapped in the
         * live pane would leave the app. A client of our own keeps it, and
         * says where it went.
         *
         * Saying so is the part that was missing. The app opened this view at
         * an address and then never heard another word: tap through three
         * links and the omnibox still read the address you started at, Back
         * and Forward still had the one entry they were born with, and Freeze
         * — which falls back to the omnibox when it cannot read a URL — saved
         * the page you came from under the name of the page you were on.
         *
         * `doUpdateVisitedHistory` rather than `onPageFinished` because it
         * also fires for `pushState`, and a single-page site is still
         * navigation to everyone except the loader.
         */
        view.webViewClient = object : WebViewClient() {
            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                if (!behind && url != null) notifyNavigated(label, url)
            }
        }
        view.webChromeClient = WebChromeClient()
        view.setBackgroundColor(Color.WHITE)
        /*
         * The desktop path opens both views `incognito`. Android has no
         * per-view profile below API 35, and the cookie jar is process-wide —
         * clearing it would sign the reader out of everything, which is worse
         * than the leak. Third-party cookies are the half that can be refused
         * per view, so they are.
         */
        try {
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        } catch (_: Throwable) {
            /* a device without a usable CookieManager is still a usable view */
        }
        if (behind) {
            // Nothing offscreen should take focus or the caret away from the
            // app; it is only ever read from, by `eval`.
            view.isFocusable = false
            view.isFocusableInTouchMode = false
        }
    }

    /**
     * Viewport CSS px to layout parameters in `parent`.
     *
     * Two conversions, in this order: CSS to device pixels via the page's own
     * `devicePixelRatio`, then the Tauri WebView's screen origin added — the
     * rectangle came from `getBoundingClientRect`, which is relative to that
     * view and not to the window. Subtracting the parent's origin at the end
     * is what makes it a margin rather than a screen coordinate.
     */
    private fun layoutFor(rect: RectArg, density: Double, parent: ViewGroup): FrameLayout.LayoutParams {
        val scale = if (density > 0) density else 1.0
        val viewport: View = appWebView ?: parent
        val viewportLoc = IntArray(2)
        viewport.getLocationOnScreen(viewportLoc)
        val screen = cssViewportToScreen(rect, scale, viewportLoc)
        val parentLoc = IntArray(2)
        parent.getLocationOnScreen(parentLoc)
        val params = FrameLayout.LayoutParams(
            maxOf(1, screen.width()),
            maxOf(1, screen.height()),
        )
        params.gravity = Gravity.TOP or Gravity.START
        params.leftMargin = screen.left - parentLoc[0]
        params.topMargin = screen.top - parentLoc[1]
        return params
    }

    private fun cssViewportToScreen(rect: RectArg, density: Double, viewportLoc: IntArray): Rect {
        return Rect(
            Math.round(rect.x * density).toInt() + viewportLoc[0],
            Math.round(rect.y * density).toInt() + viewportLoc[1],
            Math.round((rect.x + rect.width) * density).toInt() + viewportLoc[0],
            Math.round((rect.y + rect.height) * density).toInt() + viewportLoc[1],
        )
    }

    private fun destroy(label: String) {
        val view = views.remove(label) ?: return
        inFront.remove(label)
        unregisterBack(label)
        view.setOnKeyListener(null)
        try {
            view.stopLoading()
            // Leave the page before tearing the view down, or media and timers
            // keep running in a view nobody can see any more.
            view.loadUrl("about:blank")
        } catch (_: Throwable) {
            /* already gone */
        }
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    /** The app's own WebView, cached before any of ours joins the tree. */
    private fun rememberAppWebView() {
        if (appWebView != null) return
        val content = activity.window?.decorView?.findViewById<View>(android.R.id.content) ?: return
        appWebView = findWebView(content)
    }

    private fun findWebView(root: View): WebView? {
        if (root is WebView) return if (views.containsValue(root)) null else root
        if (root is ViewGroup) {
            for (i in 0 until root.childCount) {
                findWebView(root.getChildAt(i))?.let { return it }
            }
        }
        return null
    }

    // ---- back --------------------------------------------------------------

    /**
     * Back is handed to the app, which owns the only history that counts.
     *
     * Registered at `PRIORITY_OVERLAY` so it outranks the sink
     * `GestureGuardPlugin` installs while a drawing tool is up: a live page is
     * not a surface anyone is writing on, and Back there means "the previous
     * page", not "stay put".
     *
     * This used to call `goBack()` on the WebView first and only tell the app
     * once that ran out. That gave the tablet two histories — this view's,
     * which the app cannot see, and the app's own, which the buttons in the
     * omnibox walk — so Back did one thing under your thumb and another under
     * the arrow, and switching live/frozen dropped whichever place you were
     * not standing on. Two answers to "where am I" is the shape of bug that
     * had Freeze saving the wrong page.
     *
     * So the gesture reports and the app decides: step its history, or leave
     * the pane when there is nothing behind. The cost is real and accepted —
     * `goBack()` would have restored scroll and session state that a re-fetch
     * cannot. It is worth it here because a mark is bound to a capture the app
     * recorded, and a page restored behind the app's back is one your ink
     * cannot attach to.
     */
    private fun registerBack(label: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (backCallback != null && backLabel == label) return
        unregisterBack(backLabel)
        val callback = OnBackInvokedCallback { onBack(label) }
        activity.onBackInvokedDispatcher.registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_OVERLAY,
            callback,
        )
        backCallback = callback
        backLabel = label
    }

    private fun unregisterBack(label: String?) {
        if (label != null && backLabel != label) return
        val callback = backCallback ?: return
        backCallback = null
        backLabel = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        activity.onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
    }

    /**
     * The pre-Android-13 half of the same rule.
     *
     * `OnBackInvokedDispatcher` is API 33. Below it, a focused WebView still
     * sees `KEYCODE_BACK` as an ordinary key, which is enough for the live
     * pane because the live pane is the view being touched.
     */
    private fun onKey(label: String, keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode != KeyEvent.KEYCODE_BACK) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return false
        if (event.action != KeyEvent.ACTION_UP) return true
        onBack(label)
        return true
    }

    private fun onBack(label: String) {
        val view = views[label] ?: return
        if (view.visibility != View.VISIBLE) return
        notifyBackPressed()
    }

    /**
     * Tell the app that Back was pressed over the live pane.
     *
     * A DOM event on the app's own WebView rather than a plugin channel: there
     * is one listener, one live label, and nothing to say beyond the fact —
     * a channel would be the same nothing through three more layers. It is
     * also the only direction this plugin ever speaks in.
     */
    /**
     * Tell the app the live view has moved.
     *
     * Same one-way DOM event as [notifyBackExhausted], and for the same reason
     * — one listener, one direction, no channel worth building for it. The
     * label rides along here because the URL is only meaningful paired with
     * the view it belongs to, and a reader in a split has two.
     */
    private fun notifyNavigated(label: String, url: String) {
        val app = appWebView ?: return
        val script =
            "window.dispatchEvent(new CustomEvent(" +
                JSONObject.quote(NAVIGATED_EVENT) +
                ",{detail:{label:" + JSONObject.quote(label) +
                ",url:" + JSONObject.quote(url) + "}}))"
        try {
            app.evaluateJavascript(script, null)
        } catch (_: Throwable) {
            /* the app view has gone; nothing is listening */
        }
    }

    private fun notifyBackPressed() {
        val app = appWebView ?: return
        val script =
            "window.dispatchEvent(new Event(" + JSONObject.quote(BACK_EVENT) + "))"
        try {
            app.evaluateJavascript(script, null)
        } catch (_: Throwable) {
            /* the app view has gone; there is no pane left to leave */
        }
    }

    companion object {
        /** Matches `BACK_EVENT` in `androidLiveWebview.ts`. */
        const val BACK_EVENT = "lc-live-webview-back"

        /** Matches `NAVIGATED_EVENT` in `androidLiveWebview.ts`. */
        const val NAVIGATED_EVENT = "lc-live-webview-navigated"

        /**
         * Longer than the desktop bridge's own 8s, on purpose: the poll loop
         * above this treats a rejection as "the page never answered", and a
         * tablet renderer is slower than the machine that number was chosen on.
         */
        const val EVAL_TIMEOUT_MS = 10_000L
    }
}

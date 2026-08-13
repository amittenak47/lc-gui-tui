package dev.lc.whiteboard.gestureguard

import android.app.Activity
import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Keep Android's navigation gestures off the part of the screen being written on.
 *
 * On a gesture-navigation device the system claims a strip down each edge: a
 * drag inward from the left or the right is Back, and a drag up from the bottom
 * is Home. That is fine for a page you are reading and wrong for one you are
 * writing on.
 *
 * Two tools, used together while a drawing tool is up:
 *
 * 1. `setSystemGestureExclusionRects` — documented way to take Back's edge
 *    strips. Android grants 200dp per side and silently keeps only that much.
 *    The budget is enforced here. Rects are CSS viewport-relative (the WebView);
 *    converting them must *add* the WebView's screen origin, not subtract it,
 *    or the strips land above the view and the framework clips them to nothing.
 *
 * 2. Sticky immersive on the navigation bar — there is no exclusion API for
 *    Home. Hiding the bar with `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` means
 *    the first swipe reveals chrome instead of leaving the app; a second swipe
 *    after the bar is showing still goes Home. Back is also consumed while
 *    immersive so a leaked edge swipe cannot pop the activity mid-stroke.
 *
 * Leaving writing mode restores bars, unregisters the back sink, and clears
 * the exclusion list.
 */
@TauriPlugin
class GestureGuardPlugin(private val activity: Activity) : Plugin(activity) {

    private var backCallback: OnBackInvokedCallback? = null

    @InvokeArg
    class ExclusionArgs {
        /** Rects in CSS pixels, relative to the browser viewport (`getBoundingClientRect`). */
        var rects: List<RectArg> = emptyList()

        /** CSS px → device px (`window.devicePixelRatio`). Do not also scale with `displayMetrics.density`. */
        var density: Double = 1.0
    }

    @InvokeArg
    class RectArg {
        var x: Double = 0.0
        var y: Double = 0.0
        var width: Double = 0.0
        var height: Double = 0.0
    }

    @InvokeArg
    class ImmersiveArgs {
        var enabled: Boolean = false
    }

    @Command
    fun set_exclusions(invoke: Invoke) {
        val args = invoke.parseArgs(ExclusionArgs::class.java)
        val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        if (!supported) {
            invoke.resolve(JSObject().apply { put("applied", 0) })
            return
        }

        val content: View? = activity.window?.decorView?.findViewById(android.R.id.content)
        if (content == null) {
            invoke.reject("no content view")
            return
        }

        activity.runOnUiThread {
            val webView = findWebView(content)
            val viewport = webView ?: content
            val density = if (args.density > 0) args.density else 1.0
            val viewportLoc = IntArray(2)
            viewport.getLocationOnScreen(viewportLoc)

            val screenRects = args.rects
                .map { cssViewportToScreen(it, density, viewportLoc) }
                .filter { it.width() > 0 && it.height() > 0 }

            val budget =
                Math.round(MAX_EXCLUSION_DP * activity.resources.displayMetrics.density).toLong()

            // WebView often drops exclusion rects. The content parent and the decor
            // view are what the window actually consults. Same screen rects on both
            // union to one region, so the 200dp budget is not spent twice.
            val targets = LinkedHashSet<View>()
            targets.add(content)
            activity.window?.decorView?.let { targets.add(it) }

            var applied = 0
            for (target in targets) {
                val targetLoc = IntArray(2)
                target.getLocationOnScreen(targetLoc)
                val viewWidth =
                    if (target.width > 0) target.width
                    else activity.window?.decorView?.width ?: 0
                val local = screenRects.map { screenToViewLocal(it, targetLoc) }
                val (leftRects, rightRects) = partitionByEdge(local, viewWidth)
                val trimmed = withinBudget(leftRects, budget) + withinBudget(rightRects, budget)
                target.systemGestureExclusionRects = trimmed
                applied = maxOf(applied, trimmed.size)
            }
            invoke.resolve(JSObject().apply { put("applied", applied) })
        }
    }

    /**
     * Hide the navigation bar while writing so Home is not a hair-trigger, and
     * swallow Back so a leaked edge swipe cannot finish the activity.
     *
     * First swipe still *shows* the bars (sticky immersive). Second swipe, with
     * the bar visible, is still Home / Back — writing mode is not a trap.
     */
    @Command
    fun set_immersive(invoke: Invoke) {
        val args = invoke.parseArgs(ImmersiveArgs::class.java)
        activity.runOnUiThread {
            val window = activity.window
            if (window == null) {
                invoke.reject("no window")
                return@runOnUiThread
            }
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            if (args.enabled) {
                controller.hide(WindowInsetsCompat.Type.navigationBars())
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                registerBackSink()
            } else {
                controller.show(WindowInsetsCompat.Type.navigationBars())
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
                unregisterBackSink()
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
        }
    }

    private fun registerBackSink() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (backCallback != null) return
        val callback = OnBackInvokedCallback { /* stay in the activity while writing */ }
        activity.onBackInvokedDispatcher.registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            callback,
        )
        backCallback = callback
    }

    private fun unregisterBackSink() {
        val callback = backCallback ?: return
        backCallback = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        activity.onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
    }

    /** First WebView under `content`, if any — that is where Tauri renders. */
    private fun findWebView(root: View): View? {
        if (root is WebView) return root
        if (root is ViewGroup) {
            for (i in 0 until root.childCount) {
                findWebView(root.getChildAt(i))?.let { return it }
            }
        }
        return null
    }

    /**
     * Viewport CSS px → screen device px.
     *
     * `getBoundingClientRect` is relative to the WebView viewport, not the
     * screen. Adding the viewport's screen origin is what puts the strip on
     * the pixels the hand is actually touching.
     */
    private fun cssViewportToScreen(rect: RectArg, density: Double, viewportLoc: IntArray): Rect {
        return Rect(
            Math.round(rect.x * density).toInt() + viewportLoc[0],
            Math.round(rect.y * density).toInt() + viewportLoc[1],
            Math.round((rect.x + rect.width) * density).toInt() + viewportLoc[0],
            Math.round((rect.y + rect.height) * density).toInt() + viewportLoc[1],
        )
    }

    private fun screenToViewLocal(screen: Rect, targetLoc: IntArray): Rect {
        return Rect(
            screen.left - targetLoc[0],
            screen.top - targetLoc[1],
            screen.right - targetLoc[0],
            screen.bottom - targetLoc[1],
        )
    }

    /** Left-edge rects vs right-edge rects — Android budgets 200dp per edge. */
    private fun partitionByEdge(rects: List<Rect>, viewWidth: Int): Pair<List<Rect>, List<Rect>> {
        if (viewWidth <= 0) return rects to emptyList()
        val mid = viewWidth / 2
        val left = ArrayList<Rect>()
        val right = ArrayList<Rect>()
        for (rect in rects) {
            val center = rect.left + rect.width() / 2
            if (center < mid) left.add(rect) else right.add(rect)
        }
        return left to right
    }

    companion object {
        /** Android's own per-edge cap, in dp. Asking past it is silently trimmed. */
        const val MAX_EXCLUSION_DP = 200

        /**
         * Keep the rects that fit in the budget, tallest-first.
         *
         * A strip taller than the budget is clipped to a window *centred* in
         * that strip — writing happens across the page, not only at the top
         * (where chrome is absent) or the bottom (where the toolbar sits).
         */
        fun withinBudget(rects: List<Rect>, budgetPx: Long): List<Rect> {
            if (budgetPx <= 0) return emptyList()
            var left = budgetPx
            val kept = ArrayList<Rect>(rects.size)
            for (rect in rects.sortedByDescending { it.height() }) {
                if (left <= 0) break
                val height = rect.height().toLong()
                if (height <= left) {
                    kept.add(rect)
                    left -= height
                } else {
                    val keep = left.toInt()
                    val extra = rect.height() - keep
                    val top = rect.top + extra / 2
                    kept.add(Rect(rect.left, top, rect.right, top + keep))
                    left = 0
                }
            }
            return kept
        }
    }
}

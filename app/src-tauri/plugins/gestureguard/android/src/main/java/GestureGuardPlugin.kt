package dev.lc.whiteboard.gestureguard

import android.app.Activity
import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
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
 * writing on, because the strip is exactly where the margin of a notebook is —
 * a downstroke that starts too near the edge leaves the app instead of leaving
 * ink, and the stroke is lost.
 *
 * `setSystemGestureExclusionRects` is the documented way to ask for the
 * gesture back. Android grants it grudgingly and with a budget: 200dp per side,
 * measured over all rects on that edge, and the framework silently keeps only
 * the bottom-most 200dp when more is asked for. Silently is the problem — a
 * caller that asks for the whole height gets an arbitrary slice of it and no
 * error — so the budget is enforced here, where it can be reasoned about,
 * rather than discovered on a device.
 *
 * The bottom edge is deliberately *not* excluded. Home is the gesture people
 * use to leave, there is no API to take it (the exclusion list only governs the
 * back gesture's edges), and an app that made leaving unreliable would be a
 * worse bargain than one that loses the occasional stroke. The app's own bottom
 * chrome is already lifted clear of that band — see `--lc-coach-sheet-lift`.
 */
@TauriPlugin
class GestureGuardPlugin(private val activity: Activity) : Plugin(activity) {

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

    @Command
    fun set_exclusions(invoke: Invoke) {
        val args = invoke.parseArgs(ExclusionArgs::class.java)
        val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        if (!supported) {
            // Below API 29 there are no gesture strips to take back, so there is
            // nothing to do and nothing has gone wrong.
            invoke.resolve(JSObject().apply { put("applied", 0) })
            return
        }

        val content: View? = activity.window?.decorView?.findViewById(android.R.id.content)
        if (content == null) {
            invoke.reject("no content view")
            return
        }
        val target = findWebView(content) ?: content

        val density = if (args.density > 0) args.density else 1.0
        val loc = IntArray(2)
        target.getLocationOnScreen(loc)
        val rects = args.rects
            .map { cssViewportToViewLocal(it, density, loc) }
            .filter { it.width() > 0 && it.height() > 0 }

        // Budget is per edge (left / right). `Math.round(Float)` is Int; the
        // budget walk keeps a Long so a tall strip in device px cannot overflow.
        val budget =
            Math.round(MAX_EXCLUSION_DP * activity.resources.displayMetrics.density).toLong()
        val viewWidth =
            if (target.width > 0) target.width
            else activity.window?.decorView?.width ?: rects.maxOfOrNull { it.right } ?: 0
        val (leftRects, rightRects) = partitionByEdge(rects, viewWidth)
        val trimmed = withinBudget(leftRects, budget) + withinBudget(rightRects, budget)

        activity.runOnUiThread {
            target.systemGestureExclusionRects = trimmed
        }
        invoke.resolve(JSObject().apply { put("applied", trimmed.size) })
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
     * Viewport CSS px → view-local device px.
     *
     * `getBoundingClientRect` is in CSS px relative to the viewport;
     * `getLocationOnScreen` is device px. Scale with the WebView's DPR, then
     * subtract the view's screen offset.
     */
    private fun cssViewportToViewLocal(rect: RectArg, density: Double, viewLoc: IntArray): Rect {
        return Rect(
            Math.round(rect.x * density).toInt() - viewLoc[0],
            Math.round(rect.y * density).toInt() - viewLoc[1],
            Math.round((rect.x + rect.width) * density).toInt() - viewLoc[0],
            Math.round((rect.y + rect.height) * density).toInt() - viewLoc[1],
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
         * Android measures the budget per edge and drops what does not fit,
         * bottom-most first, without saying so. Choosing here means the strip
         * that survives is the one covering the most writing rather than
         * whichever one happened to be lowest on screen.
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
                    // Part of a strip is still worth having: the top of it is
                    // where the writing is, since the app's own chrome sits low.
                    kept.add(Rect(rect.left, rect.top, rect.right, rect.top + left.toInt()))
                    left = 0
                }
            }
            return kept
        }
    }
}

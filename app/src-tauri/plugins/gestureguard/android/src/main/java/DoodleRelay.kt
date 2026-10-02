package dev.lc.whiteboard.gestureguard

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.Window
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The loading doodle's pen, from the system straight to the page's ink worker.
 *
 * While the app starts, the page's thread lays out documents half a second at
 * a time, and a pen drawn by that thread stops for as long. This takes the
 * touches that start on a loading doodle before the WebView sees them and
 * posts their samples down a message channel whose other end the page has
 * handed to a worker (`util/nativeDoodle.ts`), which draws them with the
 * app's own ink. Nothing here draws.
 *
 * The worker says where the doodles are, and says it again every second; a
 * region not heard of for its time to live is dropped, so a page that died
 * mid-load cannot leave a patch of the screen deaf. A touch outside every
 * region, or any touch while none is live, goes to the WebView untouched.
 *
 * Samples go as text, one event per message: `kind|tool|x,y,pressure,time;…`
 * with kind d / m / u / c, x and y in device pixels from the WebView's
 * top-left, and a move carrying its historical samples oldest first — the
 * same points the page would have had as coalesced pointer events.
 */
internal class DoodleRelay(private val activity: Activity, private val findWebView: () -> WebView?) {

    private var port: WebMessagePortCompat? = null
    private var installed = false

    /** l, t, r, b in device px from the WebView's top-left, repeated. */
    private var regions = FloatArray(0)
    /** Controls over a doodle, in the same form: a touch starting on one is the page's. */
    private var holes = FloatArray(0)
    private var regionsUntil = 0L

    private var capturing = false
    private var pointerId = -1
    private var forwarding = false
    private val origin = IntArray(2)

    /** Open (or reopen) the channel and post its far end to the page. On the UI thread. */
    fun connect(): Boolean {
        val webView = findWebView() ?: return false
        val features = listOf(
            WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL,
            WebViewFeature.POST_WEB_MESSAGE,
            WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE,
            WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK,
        )
        if (!features.all { WebViewFeature.isFeatureSupported(it) }) return false
        port?.close()
        regions = FloatArray(0)
        val channel = WebViewCompat.createWebMessageChannel(webView)
        val mine = channel[0]
        mine.setWebMessageCallback(Handler(Looper.getMainLooper()), object : WebMessagePortCompat.WebMessageCallbackCompat() {
            override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                message?.data?.let { onRegions(it) }
            }
        })
        WebViewCompat.postWebMessage(webView, WebMessageCompat("lc-doodle-port", arrayOf(channel[1])), Uri.parse("*"))
        port = mine
        install()
        return true
    }

    /** `r|l,t,r,b;…|ttl|l,t,r,b;…` from the worker: doodles, their time to live, their controls. */
    private fun onRegions(text: String) {
        val parts = text.split("|")
        if (parts.size < 3 || parts[0] != "r") return
        regions = rects(parts[1])
        holes = if (parts.size > 3) rects(parts[3]) else FloatArray(0)
        regionsUntil = SystemClock.uptimeMillis() + (parts[2].toLongOrNull() ?: 0L)
    }

    private fun rects(text: String): FloatArray {
        val values = text.split(";").filter { it.isNotEmpty() }
            .flatMap { rect -> rect.split(",").mapNotNull { it.toFloatOrNull() } }
        return if (values.size % 4 == 0) values.toFloatArray() else FloatArray(0)
    }

    private fun within(r: FloatArray, x: Float, y: Float): Boolean {
        var i = 0
        while (i + 3 < r.size) {
            if (x >= r[i] && x <= r[i + 2] && y >= r[i + 1] && y <= r[i + 3]) return true
            i += 4
        }
        return false
    }

    /** Ahead of everything in the window, so a touch is ours before the WebView's. */
    private fun install() {
        if (installed) return
        val window = activity.window ?: return
        val base = window.callback ?: return
        window.callback = object : Window.Callback by base {
            override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                if (relay(event)) return true
                return base.dispatchTouchEvent(event)
            }
        }
        installed = true
    }

    private fun inRegion(x: Float, y: Float): Boolean {
        if (SystemClock.uptimeMillis() > regionsUntil) return false
        return within(regions, x, y) && !within(holes, x, y)
    }

    /** Whether the touch is the doodle's; if so it has been sent and the WebView never sees it. */
    private fun relay(event: MotionEvent): Boolean {
        val target = port ?: return false
        val webView = findWebView() ?: return false
        val action = event.actionMasked
        if (!capturing) {
            if (action != MotionEvent.ACTION_DOWN) return false
            webView.getLocationInWindow(origin)
            if (!inRegion(event.x - origin[0], event.y - origin[1])) return false
            capturing = true
            forwarding = true
            pointerId = event.getPointerId(0)
        }
        when (action) {
            MotionEvent.ACTION_DOWN -> send(target, "d", event, 0, false)
            MotionEvent.ACTION_MOVE -> {
                val index = event.findPointerIndex(pointerId)
                if (forwarding && index >= 0) send(target, "m", event, index, true)
            }
            MotionEvent.ACTION_POINTER_UP -> {
                // The pen's own pointer lifting while another stays down ends the stroke.
                if (forwarding && event.getPointerId(event.actionIndex) == pointerId) {
                    send(target, "u", event, event.actionIndex, false)
                    forwarding = false
                }
            }
            MotionEvent.ACTION_UP -> {
                if (forwarding) send(target, "u", event, 0, false)
                capturing = false
                forwarding = false
            }
            MotionEvent.ACTION_CANCEL -> {
                if (forwarding) target.postMessage(WebMessageCompat("c|"))
                capturing = false
                forwarding = false
            }
        }
        return true
    }

    private fun send(target: WebMessagePortCompat, kind: String, event: MotionEvent, index: Int, history: Boolean) {
        val tool = when (event.getToolType(index)) {
            MotionEvent.TOOL_TYPE_STYLUS, MotionEvent.TOOL_TYPE_ERASER -> "pen"
            MotionEvent.TOOL_TYPE_MOUSE -> "mouse"
            else -> "touch"
        }
        val ox = origin[0].toFloat()
        val oy = origin[1].toFloat()
        val out = StringBuilder(kind).append('|').append(tool).append('|')
        if (history) {
            for (h in 0 until event.historySize) {
                out.append(event.getHistoricalX(index, h) - ox).append(',')
                    .append(event.getHistoricalY(index, h) - oy).append(',')
                    .append(event.getHistoricalPressure(index, h)).append(',')
                    .append(event.getHistoricalEventTime(h)).append(';')
            }
        }
        out.append(event.getX(index) - ox).append(',')
            .append(event.getY(index) - oy).append(',')
            .append(event.getPressure(index)).append(',')
            .append(event.eventTime)
        target.postMessage(WebMessageCompat(out.toString()))
    }
}

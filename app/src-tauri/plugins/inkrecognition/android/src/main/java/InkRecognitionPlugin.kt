package dev.lc.whiteboard.inkrecognition

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.vision.digitalink.DigitalInkRecognition
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModel
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModelIdentifier
import com.google.mlkit.vision.digitalink.DigitalInkRecognizer
import com.google.mlkit.vision.digitalink.DigitalInkRecognizerOptions
import com.google.mlkit.vision.digitalink.Ink

/**
 * ML Kit Digital Ink Recognition, exposed to the whiteboard as two commands.
 *
 * The model is downloaded once (a few MB) and then everything is on-device and
 * offline — which is the whole point: the ambient coach reads handwriting every
 * 15 seconds, and neither shipping every glance to a cloud vision model nor
 * running a local vision model on a Helio G99 is viable.
 *
 * ## Known limits
 *
 * Recognition is good on prose and weak on the things a whiteboarded algorithm
 * is full of: subscripts, arrows, array brackets, and pseudocode punctuation.
 * That is why the daemon's prompts tell the coach the text is noisy and to read
 * through typos, and why a PNG to a vision model remains the documented
 * fallback.
 */
@TauriPlugin
class InkRecognitionPlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class Stroke {
        var x: DoubleArray = DoubleArray(0)
        var y: DoubleArray = DoubleArray(0)
    }

    @InvokeArg
    class RecognizeArgs {
        var strokes: List<Stroke> = emptyList()
    }

    /** Built lazily and reused; construction is the expensive part. */
    private var recognizer: DigitalInkRecognizer? = null
    private var modelReady = false
    private var downloadStarted = false

    private val model: DigitalInkRecognitionModel? by lazy {
        // "en-US" covers the Latin script used for code and prose alike.
        DigitalInkRecognitionModelIdentifier.fromLanguageTag("en-US")
            ?.let { DigitalInkRecognitionModel.builder(it).build() }
    }

    override fun load(webView: android.webkit.WebView) {
        super.load(webView)
        // Start the download at startup so the first glance isn't the one that
        // waits for it.
        ensureModel()
    }

    @Command
    fun isAvailable(invoke: Invoke) {
        ensureModel()
        invoke.resolve(JSObject().apply { put("value", modelReady) })
    }

    @Command
    fun recognize(invoke: Invoke) {
        val args = invoke.parseArgs(RecognizeArgs::class.java)

        if (!modelReady) {
            ensureModel()
            // Don't block the 15-second loop waiting on a download; the coach
            // will read typed text this time round and ink the next.
            invoke.resolve(emptyResult("model is still downloading"))
            return
        }
        val active = recognizer
        if (active == null) {
            invoke.resolve(emptyResult("recognizer unavailable"))
            return
        }

        val ink = buildInk(args.strokes)
        if (ink == null) {
            invoke.resolve(emptyResult("no usable strokes"))
            return
        }

        active
            .recognize(ink)
            .addOnSuccessListener { result ->
                val candidates = result.candidates
                val best = candidates.firstOrNull()?.text ?: ""
                val alternatives = JSArray()
                // Cap the alternatives: the caller only shows them when the top
                // guess looks wrong, and the payload crosses JNI.
                candidates.drop(1).take(3).forEach { alternatives.put(it.text) }
                invoke.resolve(
                    JSObject().apply {
                        put("text", best)
                        put("alternatives", alternatives)
                    }
                )
            }
            .addOnFailureListener { error ->
                // A recognition failure must never break the coach loop.
                invoke.resolve(emptyResult(error.message ?: "recognition failed"))
            }
    }

    /**
     * Turn the parallel coordinate arrays into an [Ink].
     *
     * Timestamps matter to ML Kit's model, and the WebView doesn't give us
     * reliable per-point ones, so points are stamped at a steady synthetic
     * cadence. That reads as normal handwriting speed and recognizes better
     * than sending no timestamps at all.
     */
    private fun buildInk(strokes: List<Stroke>): Ink? {
        val inkBuilder = Ink.builder()
        var timestamp = 0L
        var usable = 0

        for (stroke in strokes) {
            val count = minOf(stroke.x.size, stroke.y.size)
            if (count < 2) {
                // A single point is a dot, not a character; ML Kit handles it
                // poorly and it is almost always a stray palm touch.
                continue
            }
            val strokeBuilder = Ink.Stroke.builder()
            for (i in 0 until count) {
                strokeBuilder.addPoint(
                    Ink.Point.create(stroke.x[i].toFloat(), stroke.y[i].toFloat(), timestamp)
                )
                timestamp += POINT_INTERVAL_MS
            }
            inkBuilder.addStroke(strokeBuilder.build())
            usable++
            // Gap between strokes, so the model sees separate pen-downs.
            timestamp += STROKE_GAP_MS
        }

        return if (usable > 0) inkBuilder.build() else null
    }

    private fun emptyResult(reason: String): JSObject =
        JSObject().apply {
            put("text", "")
            put("alternatives", JSArray())
            put("reason", reason)
        }

    private fun ensureModel() {
        if (modelReady || downloadStarted) return
        val target = model ?: return
        downloadStarted = true

        RemoteModelManager.getInstance()
            .isModelDownloaded(target)
            .addOnSuccessListener { downloaded ->
                if (downloaded) {
                    activate(target)
                } else {
                    RemoteModelManager.getInstance()
                        .download(target, DownloadConditions.Builder().build())
                        .addOnSuccessListener { activate(target) }
                        .addOnFailureListener { downloadStarted = false }
                }
            }
            .addOnFailureListener { downloadStarted = false }
    }

    private fun activate(target: DigitalInkRecognitionModel) {
        recognizer =
            DigitalInkRecognition.getClient(
                DigitalInkRecognizerOptions.builder(target).build()
            )
        modelReady = true
    }

    private companion object {
        /** ~60 points/second, a plausible handwriting cadence. */
        const val POINT_INTERVAL_MS = 16L
        const val STROKE_GAP_MS = 120L
    }
}

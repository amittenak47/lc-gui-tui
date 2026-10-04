package dev.lc.whiteboard.voicedictation

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.Locale

/**
 * Dictate into the agent composer with Android's [SpeechRecognizer].
 *
 * One recognition ends at the first pause. While the user still wants the
 * microphone open we start another, so speech with gaps stays one session
 * until they press stop. Text is pushed to the page as `lc-voice` events;
 * the commands here only open and close that session.
 *
 * Record mode writes one WAV clip. [record_stop] returns its path and does
 * not emit the closing events — the host does, after transcription.
 * [record_cancel] deletes the clip and ends the session itself.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")
    ]
)
class VoiceDictationPlugin(private val activity: Activity) : Plugin(activity) {

    /** The app WebView events are evaluated in. Set from [load], before any command. */
    private var appWebView: WebView? = null

    private var recognizer: SpeechRecognizer? = null

    /** The user wants to be listening, across the pauses Android inserts. */
    private var active = false

    private var busyRetries = 0

    /**
     * ERROR_CLIENT in a row with nothing heard between. Restarting on it is
     * right once or twice; a recognizer that only ever answers that is broken.
     */
    private var clientRetries = 0

    /**
     * Start was asked for and not taken back. Stop can land while the
     * permission dialog is up; granting afterwards must not open the mic.
     */
    private var wantStart = false

    /** Which command the permission grant should finish: live recognizer or a clip. */
    private enum class PendingMode { LIVE, RECORD }

    private var pendingMode = PendingMode.LIVE

    /**
     * The record thread reads this. Cleared by stop and cancel so the thread
     * can leave its [AudioRecord.read] loop.
     */
    @Volatile
    private var recording = false

    private var audioRecord: AudioRecord? = null

    private var recordThread: Thread? = null

    private var recordFile: File? = null

    /**
     * Bumped per recognizer. A destroyed recognizer can still call back, and
     * that must not be read as the new session's result or error.
     */
    private var generation = 0

    /** The one pending restart, so two callbacks cannot both start listening. */
    private val restartTask = Runnable {
        if (!active) return@Runnable
        try {
            recognizer?.startListening(intent())
        } catch (_: Throwable) {
            fatal("other", "Speech recognition failed")
        }
    }

    /** Posted by [stop] so a recognizer that never calls back still ends. */
    private var stopTimeout: Runnable? = null

    /**
     * Set in [begin] and cleared in [finish]. [finish] emits the closing
     * events only while this is set, so a second call just cleans up.
     */
    private var sessionOpen = false

    /**
     * [finish] is on the stack. `destroy` can call the listener on this same
     * thread, and that callback must not destroy again.
     */
    private var finishing = false

    private val handler = Handler(Looper.getMainLooper())

    private fun listener(owner: Int) = object : RecognitionListener {
        private val stale get() = owner != generation

        override fun onReadyForSpeech(params: Bundle?) {
            if (stale) return
            emit(JSObject().apply {
                put("type", "state")
                put("listening", true)
            })
        }

        override fun onBeginningOfSpeech() {}

        override fun onRmsChanged(rmsdB: Float) {}

        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            if (stale) return
            // Stop already asked the session to end. Whatever the recognizer
            // reports after that is just the session closing.
            if (!active) {
                finish()
                return
            }
            when (error) {
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> restart()
                SpeechRecognizer.ERROR_CLIENT -> {
                    if (clientRetries < 5) {
                        clientRetries++
                        restart()
                    } else {
                        fatal("other", "Speech recognition failed")
                    }
                }
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> {
                    if (busyRetries < 3) {
                        busyRetries++
                        try {
                            recognizer?.cancel()
                        } catch (_: Throwable) {
                        }
                        restart(400)
                    } else {
                        fatal("busy", "Speech recognition is busy")
                    }
                }
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                    fatal("permission", "Microphone permission was denied")
                SpeechRecognizer.ERROR_AUDIO ->
                    fatal("audio", "The microphone couldn't be used")
                SpeechRecognizer.ERROR_NETWORK,
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                    fatal("network", "Speech recognition needs a network connection")
                SpeechRecognizer.ERROR_SERVER ->
                    fatal("server", "The speech recognition service failed")
                else -> laterError(error)
            }
        }

        override fun onResults(results: Bundle?) {
            if (stale) return
            emitText("final", results)
            busyRetries = 0
            clientRetries = 0
            if (active) restart() else finish()
        }

        override fun onPartialResults(partialResults: Bundle?) {
            if (stale) return
            clientRetries = 0
            emitText("partial", partialResults)
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    override fun load(webView: WebView) {
        super.load(webView)
        appWebView = webView
    }

    @Command
    fun is_available(invoke: Invoke) {
        activity.runOnUiThread {
            invoke.resolve(JSObject().apply {
                put("ok", SpeechRecognizer.isRecognitionAvailable(activity))
            })
        }
    }

    @Command
    fun start(invoke: Invoke) {
        // The permission launcher and the recognizer both require the main thread.
        activity.runOnUiThread {
            wantStart = true
            pendingMode = PendingMode.LIVE
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                requestPermissionForAlias("microphone", invoke, "micPermissionResult")
                return@runOnUiThread
            }
            begin(invoke)
        }
    }

    @Command
    fun record_start(invoke: Invoke) {
        activity.runOnUiThread {
            wantStart = true
            pendingMode = PendingMode.RECORD
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                requestPermissionForAlias("microphone", invoke, "micPermissionResult")
                return@runOnUiThread
            }
            beginRecord(invoke)
        }
    }

    @PermissionCallback
    fun micPermissionResult(invoke: Invoke) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            wantStart = false
            invoke.reject("Microphone permission was denied")
        } else if (wantStart) {
            when (pendingMode) {
                PendingMode.LIVE -> begin(invoke)
                PendingMode.RECORD -> beginRecord(invoke)
            }
        } else {
            // Stopped while the dialog was up. The page is waiting for an end.
            invoke.resolve(JSObject().apply { put("ok", true) })
            emit(JSObject().apply {
                put("type", "state")
                put("listening", false)
            })
            emit(JSObject().apply { put("type", "end") })
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        activity.runOnUiThread {
            // The last words still arrive in onResults; don't wait for them here.
            invoke.resolve(JSObject().apply { put("ok", true) })
            wantStart = false
            if (!active && recognizer == null) return@runOnUiThread
            active = false
            try {
                recognizer?.stopListening()
            } catch (_: Throwable) {
            }
            val timeout = Runnable { finish() }
            stopTimeout = timeout
            handler.postDelayed(timeout, 1500)
        }
    }

    /**
     * Drop a live session without waiting for the last words. The page treats
     * this as the session ending, same as a fatal error's close.
     */
    @Command
    fun cancel(invoke: Invoke) {
        activity.runOnUiThread {
            wantStart = false
            if (active || recognizer != null) {
                active = false
                try {
                    recognizer?.cancel()
                } catch (_: Throwable) {
                }
                finish()
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
        }
    }

    /**
     * Finish the clip and return its path. No state/end events: the host emits
     * those after transcription, so the page stays in the session until then.
     */
    @Command
    fun record_stop(invoke: Invoke) {
        activity.runOnUiThread {
            if (!recording) {
                invoke.reject("Not recording")
                return@runOnUiThread
            }
            val taken = takeRecording()
            if (taken == null) {
                invoke.reject("Not recording")
                return@runOnUiThread
            }
            // Cleared here, not after the join, so a live [finish] during the
            // join cannot also emit the close the host is about to send.
            sessionOpen = false
            Thread {
                try {
                    releaseRecording(taken)
                    val file = taken.file
                    if (file == null) {
                        invoke.reject("Not recording")
                        return@Thread
                    }
                    patchWavHeader(file)
                    invoke.resolve(JSObject().apply { put("path", file.absolutePath) })
                } catch (t: Throwable) {
                    invoke.reject(t.message ?: "Not recording")
                }
            }.start()
        }
    }

    /** Stop, delete the clip, and end the session. Also succeeds when nothing is recording. */
    @Command
    fun record_cancel(invoke: Invoke) {
        activity.runOnUiThread {
            cancelRecording(invoke)
        }
    }

    override fun onPause() {
        super.onPause()
        wantStart = false
        if (active || recognizer != null) {
            active = false
            try {
                recognizer?.cancel()
            } catch (_: Throwable) {
            }
            finish()
        }
        cancelRecording(null)
    }

    private fun begin(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                    invoke.reject("Speech recognition isn't available on this device")
                    return@runOnUiThread
                }
                if (active) {
                    invoke.resolve(JSObject().apply { put("ok", true) })
                    return@runOnUiThread
                }
                stopTimeout?.let { handler.removeCallbacks(it) }
                stopTimeout = null
                // Destroy before flipping `active`, so a callback from the old
                // recognizer still sees a session that is not listening.
                try {
                    recognizer?.destroy()
                } catch (_: Throwable) {
                }
                recognizer = null
                active = true
                busyRetries = 0
                clientRetries = 0
                sessionOpen = true
                generation++
                val created = SpeechRecognizer.createSpeechRecognizer(activity)
                created.setRecognitionListener(listener(generation))
                recognizer = created
                created.startListening(intent())
                invoke.resolve(JSObject().apply { put("ok", true) })
            } catch (t: Throwable) {
                finish()
                invoke.reject(t.message ?: "Speech recognition could not start")
            }
        }
    }

    private fun intent(): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
        }
    }

    /**
     * Start the next session after a short gap. Calling `startListening` from
     * inside `onResults` / `onError` returns ERROR_CLIENT or BUSY on some devices.
     */
    private fun restart(delayMs: Long = 120) {
        handler.removeCallbacks(restartTask)
        handler.postDelayed(restartTask, delayMs)
    }

    private fun finish() {
        if (finishing) return
        finishing = true
        handler.removeCallbacksAndMessages(null)
        stopTimeout = null
        wantStart = false
        // Callbacks from the recognizer being destroyed are now stale.
        generation++
        try {
            recognizer?.destroy()
        } catch (_: Throwable) {
        }
        recognizer = null
        active = false
        val open = sessionOpen
        sessionOpen = false
        finishing = false
        if (!open) return
        emit(JSObject().apply {
            put("type", "state")
            put("listening", false)
        })
        emit(JSObject().apply { put("type", "end") })
    }

    /** A fatal error ends the session. `code` is the short string the page switches on. */
    private fun fatal(code: String, message: String) {
        active = false
        emit(JSObject().apply {
            put("type", "error")
            put("code", code)
            put("message", message)
        })
        finish()
    }

    /**
     * ERROR_SERVER_DISCONNECTED, ERROR_LANGUAGE_NOT_SUPPORTED and
     * ERROR_LANGUAGE_UNAVAILABLE exist only on API 31+.
     */
    private fun laterError(error: Int) {
        if (Build.VERSION.SDK_INT >= 31) {
            when (error) {
                ERROR_SERVER_DISCONNECTED ->
                    fatal("server", "The speech recognition service failed")
                ERROR_LANGUAGE_NOT_SUPPORTED,
                ERROR_LANGUAGE_UNAVAILABLE ->
                    fatal("language", "This language isn't supported for speech recognition")
                else -> fatal("other", "Speech recognition failed")
            }
        } else {
            fatal("other", "Speech recognition failed")
        }
    }

    private fun emitText(type: String, bundle: Bundle?) {
        val text = firstCandidate(bundle)
        if (text.isNullOrBlank()) return
        emit(JSObject().apply {
            put("type", type)
            put("text", text)
        })
    }

    private fun firstCandidate(bundle: Bundle?): String? {
        return bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
    }

    /**
     * Open the mic and write a 16 kHz mono PCM WAV until [record_stop] or
     * [record_cancel]. Already recording resolves without starting another.
     */
    private fun beginRecord(invoke: Invoke) {
        activity.runOnUiThread {
            if (recording) {
                invoke.resolve(JSObject().apply { put("ok", true) })
                return@runOnUiThread
            }
            val dir = File(activity.cacheDir, "voice")
            if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory) {
                invoke.reject("The microphone couldn't be used")
                return@runOnUiThread
            }
            val cutoff = System.currentTimeMillis() - 60L * 60L * 1000L
            dir.listFiles()?.forEach { child ->
                if (child.isFile && child.lastModified() < cutoff) {
                    child.delete()
                }
            }
            val file = File(dir, "clip-${System.currentTimeMillis()}.wav")
            val minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val bufferSize = maxOf(minBuffer, SAMPLE_RATE * 2 / 4)
            val recorder = try {
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize
                )
            } catch (t: Throwable) {
                invoke.reject(t.message ?: "The microphone couldn't be used")
                return@runOnUiThread
            }
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                invoke.reject("The microphone couldn't be used")
                return@runOnUiThread
            }
            try {
                FileOutputStream(file).use { out -> out.write(wavHeader(0)) }
            } catch (t: Throwable) {
                recorder.release()
                invoke.reject(t.message ?: "The microphone couldn't be used")
                return@runOnUiThread
            }
            recording = true
            audioRecord = recorder
            recordFile = file
            val thread = Thread {
                writePcm(recorder, file, bufferSize)
            }
            recordThread = thread
            thread.start()
            try {
                recorder.startRecording()
            } catch (t: Throwable) {
                recording = false
                try {
                    thread.join(2000)
                } catch (_: InterruptedException) {
                }
                try {
                    recorder.release()
                } catch (_: Throwable) {
                }
                audioRecord = null
                recordThread = null
                recordFile = null
                file.delete()
                invoke.reject(t.message ?: "The microphone couldn't be used")
                return@runOnUiThread
            }
            sessionOpen = true
            emit(JSObject().apply {
                put("type", "state")
                put("listening", true)
            })
            invoke.resolve(JSObject().apply { put("ok", true) })
        }
    }

    /** PCM bytes past this are dropped; the thread stays up until stop clears [recording]. */
    private fun writePcm(recorder: AudioRecord, file: File, bufferSize: Int) {
        val buf = ByteArray(bufferSize.coerceAtLeast(1))
        var written = 0
        try {
            BufferedOutputStream(FileOutputStream(file, true)).use { out ->
                while (recording) {
                    val n = recorder.read(buf, 0, buf.size)
                    if (n > 0 && written < MAX_PCM_BYTES) {
                        val count = minOf(n, MAX_PCM_BYTES - written)
                        out.write(buf, 0, count)
                        written += count
                    } else if (n < 0 && recording) {
                        // read() before startRecording, or a dead recorder, returns
                        // immediately. Sleep so that wait is not a busy loop.
                        try {
                            Thread.sleep(20)
                        } catch (_: InterruptedException) {
                            return
                        }
                    }
                }
            }
        } catch (_: Throwable) {
        }
    }

    private class TakenRecording(
        val thread: Thread?,
        val record: AudioRecord?,
        val file: File?,
        val wasOpen: Boolean,
    )

    /** Detach the live clip. Null when nothing is recording. Does not emit. */
    private fun takeRecording(): TakenRecording? {
        if (!recording && audioRecord == null && recordThread == null && recordFile == null) {
            return null
        }
        val taken = TakenRecording(recordThread, audioRecord, recordFile, sessionOpen)
        recording = false
        recordThread = null
        audioRecord = null
        recordFile = null
        return taken
    }

    /** Join the writer (at most 2s), then stop and release the recorder. */
    private fun releaseRecording(taken: TakenRecording) {
        try {
            taken.thread?.join(2000)
        } catch (_: InterruptedException) {
        }
        try {
            taken.record?.stop()
        } catch (_: Throwable) {
        }
        try {
            taken.record?.release()
        } catch (_: Throwable) {
        }
    }

    /**
     * [record_cancel] and [onPause]. Deletes the clip and, when a recording
     * was open, emits state false and end. Resolves even when idle.
     */
    private fun cancelRecording(invoke: Invoke?) {
        val taken = takeRecording()
        if (taken == null) {
            invoke?.resolve(JSObject().apply { put("ok", true) })
            return
        }
        val wasOpen = taken.wasOpen
        sessionOpen = false
        Thread {
            releaseRecording(taken)
            taken.file?.delete()
            activity.runOnUiThread {
                if (wasOpen) {
                    emit(JSObject().apply {
                        put("type", "state")
                        put("listening", false)
                    })
                    emit(JSObject().apply { put("type", "end") })
                }
                invoke?.resolve(JSObject().apply { put("ok", true) })
            }
        }.start()
    }

    /** 44-byte PCM header. `dataLen` is the data chunk size, 0 until stop patches it. */
    private fun wavHeader(dataLen: Int): ByteArray {
        val header = ByteArray(44)
        header[0] = 'R'.code.toByte()
        header[1] = 'I'.code.toByte()
        header[2] = 'F'.code.toByte()
        header[3] = 'F'.code.toByte()
        putIntLe(header, 4, 36 + dataLen)
        header[8] = 'W'.code.toByte()
        header[9] = 'A'.code.toByte()
        header[10] = 'V'.code.toByte()
        header[11] = 'E'.code.toByte()
        header[12] = 'f'.code.toByte()
        header[13] = 'm'.code.toByte()
        header[14] = 't'.code.toByte()
        header[15] = ' '.code.toByte()
        putIntLe(header, 16, 16)
        putShortLe(header, 20, 1)
        putShortLe(header, 22, 1)
        putIntLe(header, 24, SAMPLE_RATE)
        putIntLe(header, 28, SAMPLE_RATE * 2)
        putShortLe(header, 32, 2)
        putShortLe(header, 34, 16)
        header[36] = 'd'.code.toByte()
        header[37] = 'a'.code.toByte()
        header[38] = 't'.code.toByte()
        header[39] = 'a'.code.toByte()
        putIntLe(header, 40, dataLen)
        return header
    }

    private fun patchWavHeader(file: File) {
        val dataLen = (file.length() - 44).coerceAtLeast(0)
        RandomAccessFile(file, "rw").use { raf ->
            raf.seek(4)
            writeIntLe(raf, (36 + dataLen).toInt())
            raf.seek(40)
            writeIntLe(raf, dataLen.toInt())
        }
    }

    private fun putIntLe(dst: ByteArray, offset: Int, value: Int) {
        dst[offset] = (value and 0xff).toByte()
        dst[offset + 1] = (value shr 8 and 0xff).toByte()
        dst[offset + 2] = (value shr 16 and 0xff).toByte()
        dst[offset + 3] = (value ushr 24 and 0xff).toByte()
    }

    private fun putShortLe(dst: ByteArray, offset: Int, value: Int) {
        dst[offset] = (value and 0xff).toByte()
        dst[offset + 1] = (value shr 8 and 0xff).toByte()
    }

    private fun writeIntLe(raf: RandomAccessFile, value: Int) {
        raf.write(value and 0xff)
        raf.write(value shr 8 and 0xff)
        raf.write(value shr 16 and 0xff)
        raf.write(value ushr 24 and 0xff)
    }

    private fun emit(detail: JSObject) {
        val script =
            "window.dispatchEvent(new CustomEvent(\"lc-voice\",{detail:" +
                detail.toString() +
                "}))"
        try {
            appWebView?.evaluateJavascript(script, null)
        } catch (_: Throwable) {
        }
    }

    private companion object {
        const val SAMPLE_RATE = 16000

        /** 15 minutes of 16 kHz mono 16-bit PCM. */
        const val MAX_PCM_BYTES = SAMPLE_RATE * 2 * 900

        /**
         * SpeechRecognizer.ERROR_SERVER_DISCONNECTED, API 31.
         * Inlined so minSdk 24 does not reference the SDK field.
         */
        const val ERROR_SERVER_DISCONNECTED = 11

        /** SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, API 31. */
        const val ERROR_LANGUAGE_NOT_SUPPORTED = 12

        /** SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE, API 31. */
        const val ERROR_LANGUAGE_UNAVAILABLE = 13
    }
}

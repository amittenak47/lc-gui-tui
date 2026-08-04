package dev.lc.whiteboard.gallerysave

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException

/**
 * Insert a PNG into the device Photos / Pictures library via MediaStore so it
 * shows up in the system gallery (not only an app-private Downloads folder),
 * and hand one to the system share sheet.
 *
 * Sharing cannot go through `navigator.share`: the WebView is served over
 * cleartext http so the LAN daemon is reachable, and the Web Share API is gated
 * on a secure context, so it is undefined. It is a native intent or nothing.
 */
@TauriPlugin
class GallerySavePlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class SaveArgs {
        var png_base64: String = ""
        var filename: String = "lc-capture.png"
    }

    @Command
    fun save_png(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        val bytes = try {
            Base64.decode(args.png_base64, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            invoke.reject("invalid png base64: ${error.message}")
            return
        }
        if (bytes.isEmpty()) {
            invoke.reject("empty png")
            return
        }

        try {
            val uri = insertPng(bytes, safeName(args.filename))
            invoke.resolve(JSObject().apply { put("uri", uri) })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "gallery save failed")
        }
    }

    @InvokeArg
    class ShareArgs {
        var png_base64: String = ""
        var filename: String = "lc-capture.png"
    }

    /**
     * Hand a PNG to the system chooser.
     *
     * Written into the app cache and exposed through a `FileProvider` rather
     * than MediaStore: sharing should not also drop a copy in the gallery, and
     * a `content://` authority we own is the only URI another app is allowed to
     * read. Cached files are the OS's to reclaim.
     */
    @Command
    fun share_png(invoke: Invoke) {
        val args = invoke.parseArgs(ShareArgs::class.java)
        val bytes = try {
            Base64.decode(args.png_base64, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            invoke.reject("invalid png base64: ${error.message}")
            return
        }
        if (bytes.isEmpty()) {
            invoke.reject("empty png")
            return
        }

        try {
            val dir = File(activity.cacheDir, "shares").apply { mkdirs() }
            val file = File(dir, safeName(args.filename))
            file.writeBytes(bytes)

            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file,
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, null).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(chooser)
            invoke.resolve(JSObject().apply { put("uri", uri.toString()) })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "share failed")
        }
    }

    private fun safeName(filename: String): String =
        filename
            .ifBlank { "lc-capture.png" }
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .let { if (it.lowercase().endsWith(".png")) it else "$it.png" }

    private fun insertPng(bytes: ByteArray, displayName: String): String {
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/lc")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }

        val collection =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }

        val uri = resolver.insert(collection, values)
            ?: throw IOException("MediaStore insert returned null")

        resolver.openOutputStream(uri).use { stream ->
            if (stream == null) throw IOException("cannot open MediaStore output stream")
            stream.write(bytes)
            stream.flush()
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        }

        return uri.toString()
    }
}

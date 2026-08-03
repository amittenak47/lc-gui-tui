package dev.lc.whiteboard.gallerysave

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException

/**
 * Insert a PNG into the device Photos / Pictures library via MediaStore so it
 * shows up in the system gallery (not only an app-private Downloads folder).
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

        val safeName = args.filename
            .ifBlank { "lc-capture.png" }
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .let { if (it.lowercase().endsWith(".png")) it else "$it.png" }

        try {
            val uri = insertPng(bytes, safeName)
            invoke.resolve(JSObject().apply { put("uri", uri) })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "gallery save failed")
        }
    }

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

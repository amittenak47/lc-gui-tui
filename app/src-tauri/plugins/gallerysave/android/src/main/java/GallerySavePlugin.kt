package dev.lc.whiteboard.gallerysave

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.net.Uri
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
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
    class DocumentArgs {
        var path: String = ""
        var filename: String = "document.pdf"
        var mime: String = "application/pdf"
    }

    private fun exportFile(args: DocumentArgs): File {
        val file = File(args.path).canonicalFile
        val root = File(activity.cacheDir, "document-exports").canonicalFile
        if (file.parentFile != root || !file.isFile) throw IOException("Export file is unavailable")
        if (args.mime !in listOf("application/pdf", "application/epub+zip", "application/zip")) throw IOException("Unsupported export format")
        return file
    }

    @Command
    fun save_document(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DocumentArgs::class.java)
            exportFile(args)
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = args.mime
                putExtra(Intent.EXTRA_TITLE, args.filename)
            }
            startActivityForResult(invoke, intent, "documentResult")
        } catch (error: Exception) { invoke.reject(error.message ?: "Cannot save document") }
    }

    @ActivityCallback
    fun documentResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().apply { put("uri", "") }); return
        }
        val uri = result.data?.data
        if (uri == null) { invoke.reject("No save location returned"); return }
        // File-to-file copy: no whole-document base64 or byte array on the Java heap.
        Thread {
            try {
                val file = exportFile(invoke.parseArgs(DocumentArgs::class.java))
                activity.contentResolver.openOutputStream(uri, "w").use { output ->
                    if (output == null) throw IOException("Cannot write to selected location")
                    file.inputStream().use { input -> input.copyTo(output, 65536) }
                }
                invoke.resolve(JSObject().apply { put("uri", uri.toString()) })
            } catch (error: Exception) {
                runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }
                invoke.reject(error.message ?: "Document save failed")
            }
        }.start()
    }

    @InvokeArg
    class SaveArgs {
        var png_base64: String = ""
        var filename: String = "lc-capture.png"
        var destination: String = "photos"
        var directory: String? = null
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
            val name = safeName(args.filename)
            val uri = if (args.destination == "folder") {
                insertDocument(bytes, name, args.directory)
            } else insertPng(bytes, name, args.destination == "downloads")
            invoke.resolve(JSObject().apply { put("uri", uri) })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "gallery save failed")
        }
    }

    @Command
    fun pick_folder(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "folderResult")
        } catch (error: Exception) { invoke.reject(error.message ?: "Folder picker unavailable") }
    }

    @ActivityCallback
    fun folderResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().apply { put("uri", "") }); return
        }
        try {
            val data = result.data ?: throw IOException("No folder returned")
            val uri = data.data ?: throw IOException("No folder returned")
            val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            activity.contentResolver.takePersistableUriPermission(uri, flags)
            invoke.resolve(JSObject().apply { put("uri", uri.toString()) })
        } catch (error: Exception) { invoke.reject(error.message ?: "Folder permission failed") }
    }

    private fun insertDocument(bytes: ByteArray, name: String, directory: String?): String {
        if (directory.isNullOrBlank()) throw IOException("Choose a capture folder in Settings")
        val tree = Uri.parse(directory)
        if (tree.scheme != "content" || !DocumentsContract.isTreeUri(tree)) throw IOException("Choose the folder again in Settings")
        val resolver = activity.contentResolver
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val uri = DocumentsContract.createDocument(resolver, parent, "image/png", name)
            ?: throw IOException("Cannot create capture; choose the folder again")
        try {
            resolver.openOutputStream(uri, "w").use { stream ->
                if (stream == null) throw IOException("Cannot write to selected folder")
                stream.write(bytes)
            }
        } catch (error: Exception) {
            runCatching { DocumentsContract.deleteDocument(resolver, uri) }
            throw error
        }
        return uri.toString()
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

    private fun insertPng(bytes: ByteArray, displayName: String, downloads: Boolean): String {
        if (downloads && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IOException("Use a selected folder on this Android version")
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, (if (downloads) Environment.DIRECTORY_DOWNLOADS else Environment.DIRECTORY_PICTURES) + "/lc")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }

        val collection =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                if (downloads) MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }

        val uri = resolver.insert(collection, values)
            ?: throw IOException("MediaStore insert returned null")

        try {
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
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
    }
}

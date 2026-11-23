package com.card3d

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Serves the files [CardStage.exportArFile] writes (`cacheDir/card3d-export/`), read-only, to the apps
 * an intent grants them to (Scene Viewer, a share target). Declared in the library's manifest with the
 * authority `<applicationId>.card3d.files`.
 */
class CardFileProvider : ContentProvider() {
  override fun onCreate() = true

  private fun file(uri: Uri): File {
    val root = directory(context ?: throw FileNotFoundException()).canonicalFile
    val f = File(root, uri.path.orEmpty().trimStart('/')).canonicalFile
    if (f.parentFile?.startsWith(root) != true || !f.isFile) throw FileNotFoundException(uri.toString())
    return f
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw SecurityException("read-only")
    return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun getType(uri: Uri): String? = when (uri.path.orEmpty().substringAfterLast('.')) {
    "glb" -> ArFormat.GLB.mimeType
    "usdz" -> ArFormat.USDZ.mimeType
    "png" -> "image/png"
    else -> "application/octet-stream"
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
    val f = file(uri)
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    return MatrixCursor(columns, 1).apply {
      addRow(columns.map { if (it == OpenableColumns.DISPLAY_NAME) f.name else if (it == OpenableColumns.SIZE) f.length() else null })
    }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

  companion object {
    /** Where shareable exports go. */
    @JvmStatic
    fun directory(context: Context) = File(context.cacheDir, "card3d-export")

    /** The `content://` URI of a file in [directory]. */
    @JvmStatic
    fun uriFor(context: Context, file: File): Uri = Uri.Builder()
      .scheme("content")
      .authority("${context.packageName}.card3d.files")
      .path(file.canonicalFile.relativeTo(directory(context).canonicalFile).path)
      .build()
  }
}

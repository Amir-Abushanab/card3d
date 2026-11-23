package com.card3d

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The design's remote files on disk. The engine reads only files and data URLs, so before a design is
 * built its http(s) URLs ([DesignReport.remoteUrls]) are downloaded here, once each, and handed to the
 * engine as local paths. Files keep their URL's extension (the engine tells SVG masks and `.hdr`
 * environments by it). Downloads use `java.net` on [Dispatchers.IO], in parallel.
 */
class AssetCache(
  /** Where the files go (default: `cacheDir/card3d-assets`). */
  val directory: File,
  /** A larger file is refused (and its layer skipped). */
  var maxFileSize: Long = 64L shl 20,
  /** Connect and read timeouts, ms. */
  var timeoutMs: Int = 30_000,
) {
  constructor(context: Context) : this(File(context.cacheDir, "card3d-assets"))

  /** The local file of each URL that could be fetched, and the URLs that couldn't. */
  data class Result(val files: Map<String, File>, val failed: List<String>)

  suspend fun files(urls: List<String>): Result {
    if (urls.isEmpty()) return Result(emptyMap(), emptyList())
    directory.mkdirs()
    val fetched = coroutineScope { urls.distinct().map { url -> async(Dispatchers.IO) { url to fetch(url) } }.awaitAll() }
    return Result(fetched.mapNotNull { (u, f) -> f?.let { u to it } }.toMap(), fetched.filter { it.second == null }.map { it.first })
  }

  /** The cached file of `url`, downloaded first when missing; null when it can't be had. Blocking. */
  fun fetch(url: String): File? {
    val target = file(url)
    if (target.isFile) return target
    val tmp = File(directory, "${target.name}.${Thread.currentThread().id}.part")
    return try {
      val connection = URL(url).openConnection().apply {
        connectTimeout = timeoutMs
        readTimeout = timeoutMs
      }
      if (connection is HttpURLConnection) {
        connection.instanceFollowRedirects = true
        if (connection.responseCode !in 200..299) {
          connection.disconnect()
          return null
        }
      }
      if (connection.contentLengthLong > maxFileSize) return null
      var size = 0L
      connection.getInputStream().use { input ->
        tmp.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            size += n
            if (size > maxFileSize) throw IOException("larger than $maxFileSize bytes")
            out.write(buf, 0, n)
          }
        }
      }
      if (size == 0L) return null
      // Another download of the same URL may have finished meanwhile: either copy will do.
      if (!tmp.renameTo(target) && !target.isFile) return null
      target
    } catch (e: IOException) {
      target.takeIf { it.isFile }
    } catch (e: IllegalArgumentException) {
      null
    } finally {
      tmp.delete()
    }
  }

  /** Where `url` is cached: its SHA-256, with its extension. */
  fun file(url: String): File {
    val hash = MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }
    val path = url.substringBefore('#').substringBefore('?').substringAfterLast('/')
    val ext = path.substringAfterLast('.', "").lowercase().filter { it.isLetterOrDigit() }.take(8)
    return File(directory, if (ext.isEmpty()) hash else "$hash.$ext")
  }
}

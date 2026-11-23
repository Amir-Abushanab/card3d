import CryptoKit
import Foundation

/// The design's remote files on disk. The engine reads only files and data URLs, so before a design
/// is built its http(s) URLs (`DesignReport.remoteURLs`) are downloaded here, once each, and handed
/// to the engine as local paths. Files keep their URL's extension (the engine tells SVG masks and
/// `.hdr` environments by it).
public struct AssetCache: Sendable {
    /// Where the files go (default: `Caches/card3d-assets`).
    public let directory: URL
    /// A larger file is refused (and its layer skipped).
    public var maxFileSize: Int = 64 << 20
    private let session: URLSession

    public init(directory: URL? = nil, session: URLSession = .shared) {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        self.directory = directory ?? caches.appendingPathComponent("card3d-assets", isDirectory: true)
        self.session = session
    }

    /// The local file for each URL that could be fetched, and the URLs that couldn't.
    public func files(for urls: [URL]) async -> (files: [URL: URL], failed: [URL]) {
        guard !urls.isEmpty else { return ([:], []) }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return await withTaskGroup(of: (URL, URL?).self) { group in
            for url in urls {
                group.addTask { (url, await fetch(url)) }
            }
            var files: [URL: URL] = [:]
            var failed: [URL] = []
            for await (url, file) in group {
                if let file { files[url] = file } else { failed.append(url) }
            }
            return (files, failed)
        }
    }

    /// The cached file of `url`, downloaded first when missing.
    func fetch(_ url: URL) async -> URL? {
        let target = file(for: url)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        do {
            let (temporary, response) = try await session.download(from: url)
            defer { try? FileManager.default.removeItem(at: temporary) }
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
            let size = (try? temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size > 0, size <= maxFileSize else { return nil }
            // Another download of the same URL may have finished meanwhile: either copy will do.
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: temporary, to: target)
            return target
        } catch {
            return FileManager.default.fileExists(atPath: target.path) ? target : nil
        }
    }

    func file(for url: URL) -> URL {
        let hash = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        let ext = url.pathExtension.lowercased().filter { $0.isLetter || $0.isNumber }
        return directory.appendingPathComponent(ext.isEmpty ? hash : "\(hash).\(ext.prefix(8))")
    }
}

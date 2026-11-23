import CoreGraphics
import Foundation
import ImageIO
import QuartzCore
import Testing

@testable import Card3D

/// The repository root (apple/Tests/Card3DTests/ → ../../..).
private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
private let designs = root.appendingPathComponent("crates/card3d-tools/designs")
/// The harness's native renders of `pixelDesigns` (`render <dir> <design.json>…`, written by apple/test.sh).
private let references = ProcessInfo.processInfo.environment["CARD3D_REFERENCE_DIR"].map(URL.init(fileURLWithPath:)) ?? root.appendingPathComponent("target/apple-reference")

/// Plain, holo, glass, a face shader, a scene, a sticker GIF.
let pixelDesigns = ["brushed-silver", "holo-front", "glass-clear", "face-liquid-metal-mark", "scene-floor", "sticker-gif"]
let poses: [(String, CardPose)] = [("front", .front), ("tilt", .tilt), ("back", .back), ("edge", .edge)]

/// Straight RGBA pixels of a PNG, as stored (no colour management).
private func pixels(png url: URL) throws -> (width: Int, height: Int, rgba: [UInt8]) {
    let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil), "missing \(url.path)")
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    #expect(image.bitsPerComponent == 8 && image.bitsPerPixel == 32)
    #expect(image.alphaInfo == .last)
    let data = try #require(image.dataProvider?.data as Data?)
    var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
    for y in 0..<image.height {
        let row = data.subdata(in: (y * image.bytesPerRow)..<(y * image.bytesPerRow + image.width * 4))
        rgba.replaceSubrange((y * image.width * 4)..<((y + 1) * image.width * 4), with: row)
    }
    return (image.width, image.height, rgba)
}

/// The harness's measure (crates/card3d-tools compare.rs): both over mid grey, the mean absolute error
/// per channel over the pixels either covers, and the share of those off by more than 24.
private func compare(_ a: [UInt8], _ b: [UInt8]) -> (mae: Double, over24: Double, card: Int) {
    var sum = 0.0
    var card = 0
    var over = 0
    for i in stride(from: 0, to: min(a.count, b.count), by: 4) {
        guard a[i + 3] > 0 || b[i + 3] > 0 else { continue }
        let (ka, kb) = (Double(a[i + 3]) / 255, Double(b[i + 3]) / 255)
        var d = 0.0
        var worst = 0.0
        for c in 0..<3 {
            let e = abs((Double(a[i + c]) * ka + 128 * (1 - ka)) - (Double(b[i + c]) * kb + 128 * (1 - kb)))
            d += e
            worst = max(worst, e)
        }
        sum += d / 3
        card += 1
        if worst > 24 { over += 1 }
    }
    return (sum / Double(max(card, 1)), 100 * Double(over) / Double(max(card, 1)), card)
}

@MainActor
@Suite struct PixelMatch {
    /// The Swift path (validation, the C ABI, an offscreen stage) draws what the engine's harness draws.
    @Test(arguments: pixelDesigns)
    func matchesTheHarness(_ name: String) async throws {
        let stage = try CardStage(offscreenWidth: 1200, height: 750, options: .init(quality: .full, fit: .studio, interactive: false, intro: false))
        let report = try await stage.setDesign(contentsOf: designs.appendingPathComponent("\(name).json"))
        #expect(report.shaderErrors.isEmpty)
        try stage.render()
        for (pose, p) in poses {
            let reference = references.appendingPathComponent("\(name)/rust-\(pose).png")
            guard FileManager.default.fileExists(atPath: reference.path) else {
                Issue.record("no reference render at \(reference.path): run apple/test.sh (it renders them with crates/card3d-tools)")
                return
            }
            let expected = try pixels(png: reference)
            let actual = try stage.snapshot(width: 1200, height: 750, pose: p)
            #expect(actual.count == expected.rgba.count)
            let (mae, over24, card) = compare(actual, expected.rgba)
            // Not vacuous: the card covers a good part of the frame.
            #expect(card > 20_000, "\(name) \(pose): only \(card) card pixels")
            print("\(name) \(pose): mean error \(String(format: "%.3f", mae)), \(String(format: "%.2f", over24)) % over 24")
            #expect(mae < 0.5, "\(name) \(pose): mean error \(mae)")
        }
    }
}

@MainActor
@Suite struct Stage {
    @Test func validationReportsAndRefuses() throws {
        let report = try CardStage.validate(#"{"recipe":{"texture":"no-such-texture"},"cardholderName":"A","logo":{"src":"https://example.com/l.png"}}"#)
        #expect(!report.errors.isEmpty)
        #expect(report.remoteURLs == [URL(string: "https://example.com/l.png")!])
        #expect(report.designJSON?.hasPrefix("{") == true)
        #expect(throws: Card3DError.self) { try CardStage.validate("[1]") }
    }

    @Test func shipsTheThirdPartyNotices() throws {
        let url = try #require(Card3DNotices.url)
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text.contains("## Rust crates") && text.contains("`wgpu`") && text.contains("SIL Open Font License"))
    }

    @Test func drawsOnAMetalLayer() async throws {
        let layer = CAMetalLayer()
        layer.frame = CGRect(x: 0, y: 0, width: 320, height: 200)
        let engine = try Engine.make(options: .init(quality: .performance), layer: layer, width: 320, height: 200, reducedMotion: false)
        let json = try String(contentsOf: designs.appendingPathComponent("holo-front.json"), encoding: .utf8)
        _ = try engine.setDesign(json, assets: "")
        // The intro runs first; a tap flips (as a click does on the web).
        var (flags, _) = engine.advance(now: CACurrentMediaTime() * 1000)
        #expect(flags & 1 != 0)
        try engine.render()
        let t = CACurrentMediaTime() * 1000
        #expect(engine.pointerDown(id: 1, x: 160, y: 100, width: 320, height: 200, now: t))
        engine.pointerUp(id: 1, x: 160, y: 100, now: t + 50)
        (flags, _) = engine.advance(now: t + 60)
        #expect(engine.flipped)
        try engine.render()
        let png = try engine.exportPNG(width: 160, height: 100, pose: nil)
        #expect(png.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
    }

    @Test func exportsAR() async throws {
        let stage = try CardStage(offscreenWidth: 64, height: 40)
        try await stage.setDesign(contentsOf: designs.appendingPathComponent("brushed-silver.json"))
        let usdz = try stage.exportARFile(.usdz, size: 256)
        defer { try? FileManager.default.removeItem(at: usdz.deletingLastPathComponent()) }
        let data = try Data(contentsOf: usdz)
        #expect(data.prefix(2) == Data("PK".utf8))
        let glb = try stage.exportAR(.glb, size: 256)
        #expect(glb.prefix(4) == Data("glTF".utf8))
    }

    @Test func optionChangesRebuild() async throws {
        let stage = try CardStage(offscreenWidth: 120, height: 75)
        try await stage.setDesign(contentsOf: designs.appendingPathComponent("brushed-silver.json"))
        let before = try stage.snapshot(width: 120, height: 75, pose: .front)
        stage.lighting = "dark"
        #expect(stage.lastError == nil)
        let after = try stage.snapshot(width: 120, height: 75, pose: .front)
        #expect(before != after)
        stage.quality = .full
        #expect(stage.lastError == nil)
        #expect(throws: Card3DError.self) { try stage.exportPNG(width: 0, height: 10) }
    }

    @Test func remoteFilesComeFromTheCache() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("card3d-cache-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = AssetCache(directory: dir)
        // A file URL stands in for a download.
        let source = designs.appendingPathComponent("brushed-silver.json")
        let missing = dir.appendingPathComponent("nope.png")
        let (files, failed) = await cache.files(for: [source, missing])
        #expect(files[source]?.pathExtension == "json")
        #expect(failed == [missing])
    }
}

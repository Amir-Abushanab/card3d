import Foundation
import Observation
import QuartzCore
import os

/// One card: its design, how it's drawn, its pose, and its exports. Show it with `CardView`, or make
/// an offscreen stage (`CardStage.offscreen`) for exports and tests.
///
/// Main-actor bound: the engine builds and draws on the thread that owns its GPU device. Building a
/// design blocks the main thread for the build itself (~0.1–0.3 s for most designs); validation and
/// downloads run off it.
@MainActor
@Observable
public final class CardStage {
    /// How the stage is set up (the web stage's options).
    public struct Options: Sendable, Hashable {
        public var quality: CardQuality
        public var fit: CardFit
        /// Drag to turn, tap to flip, double tap to reset, keys (macOS) and accessibility actions.
        public var interactive: Bool
        /// The one-shot intro on the first card (never when the system asks for reduced motion).
        public var intro: Bool
        /// The resting rotation, degrees (pitch, yaw).
        public var restingRotation: (x: Double, y: Double)
        /// What VoiceOver calls the card.
        public var label: String

        public init(quality: CardQuality = .performance, fit: CardFit = .studio, interactive: Bool = true, intro: Bool = true, restingRotation: (x: Double, y: Double) = (0, 0), label: String = "Card") {
            self.quality = quality
            self.fit = fit
            self.interactive = interactive
            self.intro = intro
            self.restingRotation = restingRotation
            self.label = label
        }

        public static func == (a: Options, b: Options) -> Bool {
            a.quality == b.quality && a.fit == b.fit && a.interactive == b.interactive && a.intro == b.intro && a.restingRotation == b.restingRotation && a.label == b.label
        }

        public func hash(into h: inout Hasher) {
            h.combine(quality)
            h.combine(fit)
            h.combine(interactive)
            h.combine(label)
        }
    }

    /// Whether the back faces the viewer.
    public private(set) var isFlipped = false
    /// The last design's report.
    public private(set) var report: DesignReport?
    /// The last failure (a design that couldn't be read, a lost GPU…); cleared by the next design.
    public private(set) var lastError: Card3DError?
    /// A design is being validated, downloaded or built.
    public private(set) var isLoading = false
    /// The card is on screen and drawn.
    public private(set) var hasCard = false

    /// The rendering tier; changing it rebuilds the card.
    public var quality: CardQuality {
        didSet {
            guard quality != oldValue else { return }
            apply { (e) throws(Card3DError) in try e.setQuality(quality) }
            view?.layoutDrawable()
        }
    }

    /// The framing, from the next frame.
    public var fit: CardFit {
        didSet {
            engine?.setFit(fit)
            requestFrame()
        }
    }

    /// A lighting preset id ("studio", "warm", "cool", "dramatic", "light", "dark") in place of the
    /// design's own; nil for the design's. Changing it rebuilds the card.
    public var lighting: String? {
        didSet {
            guard lighting != oldValue else { return }
            apply { (e) throws(Card3DError) in try e.setLighting(lighting) }
        }
    }

    public let options: Options
    @ObservationIgnored public let assetProvider: CardAssetProvider
    @ObservationIgnored public let assetCache: AssetCache

    @ObservationIgnored var engine: Engine?
    @ObservationIgnored weak var view: CardSurfaceView?
    /// The design on the stage (JSON) and its assets JSON: replayed on a new engine.
    @ObservationIgnored private var current: (json: String, assets: String)?
    @ObservationIgnored private var token = 0
    @ObservationIgnored private(set) var reducedMotion: Bool
    @ObservationIgnored private let offscreenSize: (Int, Int)?
    @ObservationIgnored private let log = Logger(subsystem: "card3d", category: "stage")

    /// A stage for `CardView`. The engine starts when the view appears.
    public init(options: Options = Options(), assetProvider: CardAssetProvider = CardAssetProvider(), assetCache: AssetCache = AssetCache()) {
        self.options = options
        self.quality = options.quality
        self.fit = options.fit
        self.assetProvider = assetProvider
        self.assetCache = assetCache
        self.reducedMotion = SystemMotion.reduced
        self.offscreenSize = nil
    }

    /// A stage without a view, drawing into a `width` × `height` px texture: stills and AR files.
    public init(offscreenWidth width: Int, height: Int, options: Options = Options(interactive: false, intro: false), assetProvider: CardAssetProvider = CardAssetProvider(), assetCache: AssetCache = AssetCache()) throws {
        self.options = options
        self.quality = options.quality
        self.fit = options.fit
        self.assetProvider = assetProvider
        self.assetCache = assetCache
        self.reducedMotion = SystemMotion.reduced
        self.offscreenSize = (width, height)
        engine = try Engine.make(options: options, layer: nil, width: width, height: height, reducedMotion: reducedMotion)
    }

    // ── designs ──────────────────────────────────────────────────────────────

    /// Validates a design (`ensureDesign` + `lintDesign`, as the web does) without drawing it. Any
    /// thread. Throws `.design` when there is nothing to draw.
    public nonisolated static func validate(_ json: String) throws(Card3DError) -> DesignReport {
        try Engine.validate(json)
    }

    @concurrent
    private nonisolated static func validateOffMain(_ json: String) async throws(Card3DError) -> DesignReport {
        try Engine.validate(json)
    }

    /// Shows a design (`CardDesign` JSON): validates it, downloads its remote files, builds the card.
    /// `baseDirectory`: where relative `src`s are (a bundled design's folder). The card keeps its
    /// pose. A newer call supersedes one still loading (that one returns its report without drawing).
    @discardableResult
    public func setDesign(json: String, baseDirectory: URL? = nil) async throws(Card3DError) -> DesignReport {
        token += 1
        let mine = token
        isLoading = true
        defer { if mine == token { isLoading = false } }
        do {
            var report = try await Self.validateOffMain(json)
            let downloads = await assetCache.files(for: report.remoteURLs)
            report.failedDownloads = downloads.failed
            guard mine == token else { return report }
            let assets = assetsJSON(files: downloads.files, base: baseDirectory)
            current = (json, assets)
            lastError = nil
            self.report = report
            if let engine {
                let built = try engine.setDesign(json, assets: assets)
                self.report?.shaderErrors = built.shaderErrors
                hasCard = true
                isFlipped = engine.flipped
                requestFrame()
            } else {
                // Built when the view attaches (`attach`), now if it's in a window.
                view?.startEngine()
            }
            for url in downloads.failed {
                log.warning("couldn't download \(url.absoluteString, privacy: .public); its layer is skipped")
            }
            return self.report ?? report
        } catch {
            fail(error)
            throw error
        }
    }

    /// A design from a JSON file (relative `src`s resolve against its folder).
    @discardableResult
    public func setDesign(contentsOf file: URL) async throws -> DesignReport {
        let json = try String(contentsOf: file, encoding: .utf8)
        return try await setDesign(json: json, baseDirectory: file.deletingLastPathComponent())
    }

    private func assetsJSON(files: [URL: URL], base: URL?) -> String {
        var o: [String: Any] = ["files": Dictionary(uniqueKeysWithValues: files.map { ($0.key.absoluteString, $0.value.path) })]
        if let base { o["base"] = base.path }
        if let f = assetProvider.nameFontFamily { o["nameFontFamily"] = f }
        let data = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Runs an option change on the engine (rebuilds), reporting a failure.
    private func apply(_ change: (Engine) throws(Card3DError) -> Void) {
        guard let engine else { return }
        do {
            try change(engine)
            requestFrame()
        } catch {
            fail(error)
        }
    }

    private func fail(_ e: Card3DError) {
        lastError = e
        log.error("\(e.localizedDescription, privacy: .public)")
        if e.stoppedStage {
            // The engine stopped: drop it; the next design (or the view) starts a new one.
            engine = nil
            hasCard = false
            view?.stopEngine()
        }
    }

    // ── the card ─────────────────────────────────────────────────────────────

    /// Turns the card over (animated).
    public func flip() {
        engine?.toggleFlip(now: Self.now)
        requestFrame()
    }

    /// Shows the front (false) or the back (true).
    public func setFlipped(_ flipped: Bool) {
        engine?.setFlipped(flipped, now: Self.now)
        requestFrame()
    }

    /// Back to the resting pose, front up.
    public func reset() {
        engine?.reset()
        requestFrame()
    }

    /// The slot's rotation, independent of the interaction (radians, Euler XYZ).
    public func setRotation(_ pose: CardPose) {
        engine?.setRotation(pose)
        requestFrame()
    }

    /// The interaction's pitch and yaw, degrees.
    public var rotation: (x: Double, y: Double) { engine?.rotation ?? (0, 0) }

    // ── exports ──────────────────────────────────────────────────────────────

    /// A PNG of the card, `width` × `height` px, transparent around it. `pose`: nil for the card as it
    /// is on screen; else the slot's rotation with the interaction's pose left out.
    public func exportPNG(width: Int, height: Int, pose: CardPose? = nil) throws(Card3DError) -> Data {
        guard let engine else { throw .invalidArgument("no card yet") }
        return try engine.exportPNG(width: width, height: height, pose: pose)
    }

    /// The raw pixels of a still: straight-alpha RGBA, rows top first.
    public func snapshot(width: Int, height: Int, pose: CardPose? = nil) throws(Card3DError) -> [UInt8] {
        guard let engine else { throw .invalidArgument("no card yet") }
        return try engine.snapshot(width: width, height: height, pose: pose)
    }

    /// The card's AR model: USDZ for AR Quick Look, or GLB; its baked maps `size` px.
    public func exportAR(_ format: ARFormat = .usdz, size: Int = 2048, upright: Bool = false) throws(Card3DError) -> Data {
        guard let engine else { throw .invalidArgument("no card yet") }
        return try engine.exportAR(format, size: size, upright: upright)
    }

    /// `exportAR` written to a temporary file, ready for `.quickLookPreview` (AR Quick Look on iOS).
    public func exportARFile(_ format: ARFormat = .usdz, size: Int = 2048, upright: Bool = false, name: String = "card") throws -> URL {
        let data = try exportAR(format, size: size, upright: upright)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("card3d-ar-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(name).\(format.fileExtension)")
        try data.write(to: url)
        return url
    }

    /// Draws a frame now (offscreen stages; views draw on their own).
    public func render() throws(Card3DError) {
        guard let engine else { throw .invalidArgument("no stage") }
        _ = engine.advance(now: Self.now)
        try engine.render()
    }

    // ── the view's side ──────────────────────────────────────────────────────

    static var now: Double { CACurrentMediaTime() * 1000 }

    /// Starts the engine on the view's layer and builds the current design.
    func attach(_ view: CardSurfaceView, layer: CAMetalLayer, width: Int, height: Int) {
        self.view = view
        guard engine == nil else { return }
        do {
            let e = try Engine.make(options: Options(quality: quality, fit: fit, interactive: options.interactive, intro: options.intro, restingRotation: options.restingRotation), layer: layer, width: width, height: height, reducedMotion: reducedMotion)
            engine = e
            if let l = lighting { try e.setLighting(l) }
            if let c = current {
                let built = try e.setDesign(c.json, assets: c.assets)
                report?.shaderErrors = built.shaderErrors
                hasCard = true
            }
        } catch {
            fail(error)
        }
    }

    /// The view is going away (its layer with it): the engine stops; the design stays for the next view.
    func detach(_ view: CardSurfaceView) {
        guard self.view === view else { return }
        engine = nil
        hasCard = false
        self.view = nil
    }

    func requestFrame() {
        view?.requestFrame()
    }

    /// One frame: advance, draw. Returns whether to draw the next frame too, and when to wake otherwise.
    func frame(width: Int, height: Int) -> (animating: Bool, wake: Double?) {
        guard let engine else { return (false, nil) }
        engine.resize(width: width, height: height)
        let (flags, wake) = engine.advance(now: Self.now)
        if flags & 4 != 0 { isFlipped = engine.flipped }
        do {
            try engine.render()
        } catch {
            fail(error)
            return (false, nil)
        }
        return (flags & 1 != 0, wake)
    }

    func setSystemReducedMotion(_ reduced: Bool) {
        reducedMotion = reduced
        engine?.setReducedMotion(reduced)
        requestFrame()
    }

    func setVisible(_ visible: Bool) {
        engine?.setVisible(visible)
    }

    // Input, forwarded by the view (points from its top left).
    func pointerDown(id: Int32, x: Double, y: Double, width: Double, height: Double) -> Bool {
        guard options.interactive, let engine else { return false }
        return engine.pointerDown(id: id, x: x, y: y, width: width, height: height, now: Self.now)
    }
    func pointerMove(id: Int32, x: Double, y: Double) -> Bool { engine?.pointerMove(id: id, x: x, y: y, now: Self.now) ?? false }
    func pointerUp(id: Int32, x: Double, y: Double) { engine?.pointerUp(id: id, x: x, y: y, now: Self.now) }
    func pointerCancel(id: Int32) { engine?.pointerCancel(id: id) }
    func setPointer(_ ndc: (Double, Double)?) { engine?.setPointer(ndc) }
    func wheel(_ delta: Double) { engine?.wheel(delta) }
    func doubleClick() {
        guard options.interactive else { return }
        engine?.doubleClick()
    }
    func key(reset: Bool) -> Bool { options.interactive && (engine?.key(reset: reset, now: Self.now) ?? false) }

    /// VoiceOver's description.
    var accessibilityValue: String { isFlipped ? "showing the back" : "showing the front" }
}

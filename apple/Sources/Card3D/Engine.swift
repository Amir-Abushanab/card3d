import Card3DFFI
import Foundation
import QuartzCore

/// The C ABI (`card3d.h`) in Swift terms: one engine stage. Not thread-safe: the owning `CardStage`
/// keeps it on the main actor. Frees the stage when released.
final class Engine {
    private let handle: OpaquePointer

    private init(handle: OpaquePointer) {
        self.handle = handle
    }

    deinit {
        card3d_stage_free(handle)
    }

    /// Starts the GPU on `layer` (nil: an offscreen texture), `width` × `height` device pixels.
    static func make(options: CardStage.Options, layer: CAMetalLayer?, width: Int, height: Int, reducedMotion: Bool) throws(Card3DError) -> Engine {
        let environments = Bundle.module.url(forResource: "environments", withExtension: nil)?.path
        var out: OpaquePointer?
        var error: UnsafeMutablePointer<CChar>?
        let status: Card3dStatus = withOptionalCString(environments) { dir in
            var o = Card3dStageOptions(
                quality: options.quality.rawValue,
                fit: options.fit.rawValue,
                interactive: options.interactive,
                intro: options.intro && !reducedMotion,
                reduced_motion: reducedMotion,
                fit_to_viewport: false,
                rotation_x: options.restingRotation.x,
                rotation_y: options.restingRotation.y,
                environments_dir: dir
            )
            let kind = layer == nil ? CARD3D_SURFACE_KIND_OFFSCREEN : CARD3D_SURFACE_KIND_METAL_LAYER
            let pointer = layer.map { Unmanaged.passUnretained($0).toOpaque() }
            var s = Card3dSurface(kind: kind.rawValue, handle: pointer, width: UInt32(max(1, width)), height: UInt32(max(1, height)))
            return card3d_stage_new(&o, &s, &out, &error)
        }
        try check(status, error)
        guard let out else { throw .engine("no stage") }
        return Engine(handle: out)
    }

    /// `card3d_validate`: any thread, no GPU.
    static func validate(_ json: String) throws(Card3DError) -> DesignReport {
        var report: UnsafeMutablePointer<CChar>?
        var error: UnsafeMutablePointer<CChar>?
        let status = card3d_validate(json, &report, &error)
        try check(status, error)
        return try decodeReport(take(report))
    }

    func setDesign(_ json: String, assets: String) throws(Card3DError) -> DesignReport {
        var report: UnsafeMutablePointer<CChar>?
        var error: UnsafeMutablePointer<CChar>?
        let status = card3d_stage_set_design(handle, json, assets, &report, &error)
        try Self.check(status, error)
        return try Self.decodeReport(Self.take(report))
    }

    func resize(width: Int, height: Int) {
        card3d_stage_resize(handle, UInt32(max(1, width)), UInt32(max(1, height)))
    }

    /// Flags (`CARD3D_ANIMATING` …) and the ms until a scheduled change, if any.
    func advance(now: Double) -> (flags: UInt32, wake: Double?) {
        var wake = -1.0
        let flags = card3d_stage_advance(handle, now, &wake)
        return (flags, wake >= 0 ? wake : nil)
    }

    func render() throws(Card3DError) {
        var error: UnsafeMutablePointer<CChar>?
        try Self.check(card3d_stage_render(handle, &error), error)
    }

    func setQuality(_ q: CardQuality) throws(Card3DError) {
        var error: UnsafeMutablePointer<CChar>?
        try Self.check(card3d_stage_set_quality(handle, q.rawValue, &error), error)
    }

    func setFit(_ f: CardFit) {
        card3d_stage_set_fit(handle, f.rawValue)
    }

    func setLighting(_ id: String?) throws(Card3DError) {
        var error: UnsafeMutablePointer<CChar>?
        let status = withOptionalCString(id) { card3d_stage_set_lighting(handle, $0, &error) }
        try Self.check(status, error)
    }

    func setReducedMotion(_ on: Bool) { card3d_stage_set_reduced_motion(handle, on) }
    func setVisible(_ on: Bool) { card3d_stage_set_visible(handle, on) }
    func setRotation(_ p: CardPose) { card3d_stage_set_rotation(handle, p.x, p.y, p.z) }
    func setCameraOrbit(azimuth: Double, elevation: Double, distance: Double) { card3d_stage_set_camera_orbit(handle, azimuth, elevation, distance) }

    func pointerDown(id: Int32, x: Double, y: Double, width: Double, height: Double, now: Double) -> Bool {
        card3d_stage_pointer_down(handle, id, x, y, width, height, now)
    }
    func pointerMove(id: Int32, x: Double, y: Double, now: Double) -> Bool { card3d_stage_pointer_move(handle, id, x, y, now) }
    func pointerUp(id: Int32, x: Double, y: Double, now: Double) { card3d_stage_pointer_up(handle, id, x, y, now) }
    func pointerCancel(id: Int32) { card3d_stage_pointer_cancel(handle, id) }
    /// Normalised device coordinates, or nil when the pointer left.
    func setPointer(_ ndc: (Double, Double)?) { card3d_stage_set_pointer(handle, ndc != nil, ndc?.0 ?? 0, ndc?.1 ?? 0) }
    func wheel(_ delta: Double) { card3d_stage_wheel(handle, delta) }
    func doubleClick() { card3d_stage_double_click(handle) }
    /// `reset`: Home / Escape; else flip (Enter / Space).
    func key(reset: Bool, now: Double) -> Bool { card3d_stage_key(handle, reset ? 1 : 2, now) }
    func toggleFlip(now: Double) { card3d_stage_toggle_flip(handle, now) }
    func setFlipped(_ on: Bool, now: Double) { card3d_stage_set_flipped(handle, on, now) }
    func reset() { card3d_stage_reset(handle) }
    var flipped: Bool { card3d_stage_flipped(handle) }
    var rotation: (x: Double, y: Double) {
        var x = 0.0
        var y = 0.0
        card3d_stage_rotation(handle, &x, &y)
        return (x, y)
    }

    /// Straight-alpha RGBA rows, top first.
    func snapshot(width: Int, height: Int, pose: CardPose?) throws(Card3DError) -> [UInt8] {
        try bytes { out, error in
            withPose(pose) { card3d_stage_snapshot(handle, UInt32(clamping: width), UInt32(clamping: height), $0, out, error) }
        }
    }

    func exportPNG(width: Int, height: Int, pose: CardPose?) throws(Card3DError) -> Data {
        Data(try bytes { out, error in
            withPose(pose) { card3d_stage_export_png(handle, UInt32(clamping: width), UInt32(clamping: height), $0, out, error) }
        })
    }

    func exportAR(_ format: ARFormat, size: Int, upright: Bool) throws(Card3DError) -> Data {
        Data(try bytes { out, error in card3d_stage_export_ar(handle, format.rawValue, UInt32(clamping: size), upright, out, error) })
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private func bytes(_ call: (UnsafeMutablePointer<Card3dBytes>, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Card3dStatus) throws(Card3DError) -> [UInt8] {
        var out = Card3dBytes(data: nil, len: 0)
        var error: UnsafeMutablePointer<CChar>?
        let status = call(&out, &error)
        try Self.check(status, error)
        defer { card3d_bytes_free(out) }
        guard let data = out.data else { return [] }
        return Array(UnsafeBufferPointer(start: data, count: out.len))
    }

    private func withPose<R>(_ pose: CardPose?, _ body: (UnsafePointer<Double>?) -> R) -> R {
        guard let pose else { return body(nil) }
        let values = [pose.x, pose.y, pose.z]
        return values.withUnsafeBufferPointer { body($0.baseAddress) }
    }

    /// The library's string, freed.
    static func take(_ s: UnsafeMutablePointer<CChar>?) -> String {
        guard let s else { return "" }
        defer { card3d_string_free(s) }
        return String(cString: s)
    }

    static func check(_ status: Card3dStatus, _ error: UnsafeMutablePointer<CChar>?) throws(Card3DError) {
        let message = take(error)
        switch status {
        case CARD3D_STATUS_OK: return
        case CARD3D_STATUS_DESIGN: throw .design(message)
        case CARD3D_STATUS_GPU: throw .gpu(message)
        case CARD3D_STATUS_EXPORT: throw .export(message)
        case CARD3D_STATUS_PANIC: throw .engine(message)
        default: throw .invalidArgument(message)
        }
    }

    private struct ReportJSON: Decodable {
        var errors: [DesignIssue]
        var warnings: [DesignIssue]
        var remote: [String]
        var shaderErrors: [ShaderLayerError]?
    }

    /// `{ design?, errors, warnings, remote, shaderErrors }`.
    static func decodeReport(_ json: String) throws(Card3DError) -> DesignReport {
        let data = Data(json.utf8)
        let r: ReportJSON
        do {
            r = try JSONDecoder().decode(ReportJSON.self, from: data)
        } catch {
            throw .engine("unreadable report: \(error)")
        }
        // The design is the report's first member (`{"design":{…},"errors":…`): cut it out as text.
        var design: String?
        if json.hasPrefix("{\"design\":"), let end = json.range(of: ",\"errors\":", options: .backwards) {
            design = String(json[json.index(json.startIndex, offsetBy: 10)..<end.lowerBound])
        }
        return DesignReport(
            errors: r.errors,
            warnings: r.warnings,
            remoteURLs: r.remote.compactMap(URL.init(string:)),
            failedDownloads: [],
            shaderErrors: r.shaderErrors ?? [],
            designJSON: design
        )
    }
}

/// `body` with `s` as a C string, or NULL.
private func withOptionalCString<R>(_ s: String?, _ body: (UnsafePointer<CChar>?) -> R) -> R {
    guard let s else { return body(nil) }
    return s.withCString { body($0) }
}

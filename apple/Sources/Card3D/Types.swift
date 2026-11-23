import Foundation

/// The rendering tier (`Quality` in the engine): surface map size, environment resolution and the
/// pixel-ratio ceiling.
public enum CardQuality: UInt32, Sendable, CaseIterable {
    /// Phones and embeds (the default): 256 px surface maps, pixel ratio up to 1.25.
    case performance = 0
    /// Desktop: 512 px surface maps, pixel ratio up to 2.
    case full = 1

    /// The largest pixel ratio the tier draws at (the web stage's `QUALITY_PRESETS[q].dpr[1]`).
    var maxPixelRatio: Double { self == .full ? 2 : 1.25 }
}

/// How the card is framed.
public enum CardFit: UInt32, Sendable, CaseIterable {
    /// The fixed studio camera, with room for a full turn.
    case studio = 0
    /// The card fills the view with a margin; the camera backs off as it turns.
    case contain = 1
}

/// The slot's rotation for a still (radians, Euler XYZ), the interaction's pose left out.
public struct CardPose: Sendable, Hashable {
    public var x: Double
    public var y: Double
    public var z: Double

    public init(x: Double = 0, y: Double = 0, z: Double = 0) {
        self.x = x
        self.y = y
        self.z = z
    }

    /// The comparison harness's parity poses.
    public static let front = CardPose()
    public static let tilt = CardPose(x: -0.22, y: 0.38, z: 0.04)
    public static let back = CardPose(y: .pi)
    public static let edge = CardPose(x: 0.1, y: 1.25)
}

/// An AR model's file format.
public enum ARFormat: UInt32, Sendable {
    /// glTF binary (Scene Viewer, three.js, Blender).
    case glb = 0
    /// USDZ: what AR Quick Look opens.
    case usdz = 1

    public var fileExtension: String { self == .usdz ? "usdz" : "glb" }
}

/// One validation finding: where (`recipe.texture`, "" for the whole design) and what.
public struct DesignIssue: Sendable, Hashable, Codable {
    public var path: String
    public var message: String
}

/// A face shader layer that didn't compile (the card still draws without it).
public struct ShaderLayerError: Sendable, Hashable, Codable {
    public struct Line: Sendable, Hashable, Codable {
        /// The line in the layer's own code (0: the whole shader).
        public var line: Int
        public var message: String
    }

    public var index: Int
    /// "front" or "back".
    public var side: String
    public var errors: [Line]
}

/// What `validate` and `setDesign` found: the design still draws, with the sanitizer's fixes.
public struct DesignReport: Sendable, Hashable {
    /// Parts that aren't what was written (unknown fields or ids, values of the wrong kind): dropped or
    /// replaced.
    public var errors: [DesignIssue]
    /// Clamped values and likely mistakes.
    public var warnings: [DesignIssue]
    /// The design's remote files (images, GIFs, a font, a model, an environment).
    public var remoteURLs: [URL]
    /// Remote files that couldn't be downloaded (their layers are skipped, as on the web).
    public var failedDownloads: [URL]
    /// Face shader layers that didn't compile (after `setDesign`).
    public var shaderErrors: [ShaderLayerError]
    /// The complete design JSON as the engine draws it (`validate` only).
    public var designJSON: String?
}

/// What went wrong.
public enum Card3DError: Error, Sendable, Equatable, LocalizedError {
    /// A bad argument, or no card yet.
    case invalidArgument(String)
    /// The design couldn't be read at all: nothing to draw.
    case design(String)
    /// No GPU, a lost device or a GPU error. The stage stopped; `CardView` makes a new one on the next
    /// design.
    case gpu(String)
    /// An export couldn't be made.
    case export(String)
    /// The engine failed unexpectedly (caught at the library's boundary). The stage stopped.
    case engine(String)

    public var errorDescription: String? {
        switch self {
        case .invalidArgument(let m), .design(let m), .gpu(let m), .export(let m), .engine(let m): m
        }
    }

    /// Whether the stage stopped (a new one is needed).
    public var stoppedStage: Bool {
        switch self {
        case .gpu, .engine: true
        default: false
        }
    }
}

/// An asset provider (`AssetProvider` on the web): its name font, for designs without a font of their
/// own.
public struct CardAssetProvider: Sendable, Hashable {
    public var nameFontFamily: String?

    public init(nameFontFamily: String? = nil) {
        self.nameFontFamily = nameFontFamily
    }
}

/// The licences and copyright notices of the third-party code (the Rust crates compiled into the
/// engine, code ported from other projects), the card fonts and the scene environments this package
/// ships: `THIRD_PARTY_NOTICES.md` (Markdown) in the package's resources. Show it, or link to it,
/// in the app's acknowledgements.
public enum Card3DNotices {
    public static let url: URL? = Bundle.module.url(forResource: "THIRD_PARTY_NOTICES", withExtension: "md")
}

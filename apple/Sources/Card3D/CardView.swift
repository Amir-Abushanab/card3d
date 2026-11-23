import QuartzCore
import SwiftUI

#if os(iOS)
import UIKit
/// `UIView` on iOS, `NSView` on macOS.
public typealias CardPlatformView = UIView
#else
import AppKit
/// `UIView` on iOS, `NSView` on macOS.
public typealias CardPlatformView = NSView
#endif

/// The card in SwiftUI: a `CAMetalLayer` the engine draws on. Drag to turn it, tap (click) to flip,
/// double tap to reset, as on the web; on macOS also Return / Space and Escape / Home. VoiceOver reads
/// it as a button that flips, with a reset action.
///
/// ```swift
/// @State private var stage = CardStage()
/// var body: some View {
///     CardView(stage: stage)
///         .task { try? await stage.setDesign(json: json) }
/// }
/// ```
public struct CardView {
    let stage: CardStage

    public init(stage: CardStage) {
        self.stage = stage
    }
}

#if os(iOS)
extension CardView: UIViewRepresentable {
    public func makeUIView(context: Context) -> CardSurfaceView { CardSurfaceView(stage: stage) }
    public func updateUIView(_ view: CardSurfaceView, context: Context) { view.stage = stage }
    public static func dismantleUIView(_ view: CardSurfaceView, coordinator: ()) { view.teardown() }
}
#else
extension CardView: NSViewRepresentable {
    public func makeNSView(context: Context) -> CardSurfaceView { CardSurfaceView(stage: stage) }
    public func updateNSView(_ view: CardSurfaceView, context: Context) { view.stage = stage }
    public static func dismantleNSView(_ view: CardSurfaceView, coordinator: ()) { view.teardown() }
}
#endif

/// The system's reduced-motion setting.
@MainActor
enum SystemMotion {
    static var reduced: Bool {
        #if os(iOS)
        UIAccessibility.isReduceMotionEnabled
        #else
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #endif
    }
}

/// Breaks the display link's strong reference to its target. The link runs on the main run loop.
@MainActor
private final class FrameTarget: NSObject {
    weak var view: CardSurfaceView?

    @objc func step(_ link: CADisplayLink) {
        view?.step()
    }
}

/// The view `CardView` wraps: owns the layer, the frame loop and the input.
///
/// Frames are drawn on demand: after input, a design or a resize, then every display frame only while
/// the engine reports something animating, and otherwise once when it asks to be woken (a GIF
/// sticker's next frame). Nothing is drawn while the app is in the background.
public final class CardSurfaceView: CardPlatformView {
    var stage: CardStage {
        didSet {
            guard stage !== oldValue else { return }
            oldValue.detach(self)
            startEngine()
        }
    }

    private let target = FrameTarget()
    private var link: CADisplayLink?
    private var wake: Timer?
    private var observers: [NSObjectProtocol] = []
    private var foreground = true
    private var tornDown = false
    /// Touch and mouse pointers by id.
    private var pointerIDs: [ObjectIdentifier: Int32] = [:]
    private var nextPointerID: Int32 = 1

    init(stage: CardStage) {
        self.stage = stage
        super.init(frame: .zero)
        target.view = self
        setUp()
        observeSystem()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    var metalLayer: CAMetalLayer {
        // The layer is a CAMetalLayer by construction (layerClass / makeBackingLayer).
        layer as! CAMetalLayer
    }

    /// The scale the engine draws at: the screen's, capped by the quality tier.
    private var drawScale: Double {
        #if os(iOS)
        let screen = window?.screen.scale ?? traitCollection.displayScale
        #else
        let screen = window?.backingScaleFactor ?? 2
        #endif
        return min(max(1, Double(screen)), stage.quality.maxPixelRatio)
    }

    private var drawableSize: (Int, Int) {
        let s = drawScale
        return (max(1, Int((bounds.width * s).rounded())), max(1, Int((bounds.height * s).rounded())))
    }

    func layoutDrawable() {
        metalLayer.contentsScale = drawScale
        requestFrame()
    }

    /// Starts the engine on this view's layer once it is in a window.
    func startEngine() {
        guard !tornDown, window != nil else { return }
        let (w, h) = drawableSize
        metalLayer.contentsScale = drawScale
        stage.attach(self, layer: metalLayer, width: w, height: h)
        updateAccessibility()
        requestFrame()
    }

    /// The engine stopped (a GPU failure): no more frames until it starts again.
    func stopEngine() {
        link?.isPaused = true
        wake?.invalidate()
    }

    /// The view is leaving: the engine goes before its layer.
    func teardown() {
        tornDown = true
        link?.invalidate()
        link = nil
        wake?.invalidate()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        #if os(macOS)
        observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        #endif
        observers = []
        stage.detach(self)
    }

    // ── the frame loop ─────────────────────────────────────────────────────────

    func requestFrame() {
        guard !tornDown, foreground, window != nil else { return }
        if link == nil {
            #if os(iOS)
            let l = CADisplayLink(target: target, selector: #selector(FrameTarget.step(_:)))
            #else
            let l = displayLink(target: target, selector: #selector(FrameTarget.step(_:)))
            #endif
            l.add(to: .main, forMode: .common)
            link = l
        }
        link?.isPaused = false
    }

    fileprivate func step() {
        wake?.invalidate()
        wake = nil
        guard foreground, window != nil else {
            link?.isPaused = true
            return
        }
        let (w, h) = drawableSize
        let (animating, wakeMs) = stage.frame(width: w, height: h)
        updateAccessibility()
        if !animating {
            link?.isPaused = true
            if let wakeMs {
                wake = Timer.scheduledTimer(withTimeInterval: max(0.001, wakeMs / 1000), repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated { self?.requestFrame() }
                }
            }
        }
    }

    private func setForeground(_ on: Bool) {
        guard on != foreground else { return }
        foreground = on
        stage.setVisible(on)
        if on {
            requestFrame()
        } else {
            link?.isPaused = true
            wake?.invalidate()
            cancelPointers()
        }
    }

    private func observeSystem() {
        let center = NotificationCenter.default
        let on = { [weak self] (name: Notification.Name, center: NotificationCenter, body: @escaping @MainActor (CardSurfaceView) -> Void) in
            self?.observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    if let self { body(self) }
                }
            })
        }
        #if os(iOS)
        on(UIApplication.didEnterBackgroundNotification, center) { $0.setForeground(false) }
        on(UIApplication.willEnterForegroundNotification, center) { $0.setForeground(true) }
        on(UIAccessibility.reduceMotionStatusDidChangeNotification, center) { $0.stage.setSystemReducedMotion(SystemMotion.reduced) }
        #else
        on(NSApplication.didHideNotification, center) { $0.setForeground(false) }
        on(NSApplication.didUnhideNotification, center) { $0.setForeground(true) }
        on(NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, NSWorkspace.shared.notificationCenter) { $0.stage.setSystemReducedMotion(SystemMotion.reduced) }
        #endif
    }

    // ── input (the web stage's pointer events) ──────────────────────────────────

    private func pointerID(_ key: ObjectIdentifier) -> Int32 {
        if let id = pointerIDs[key] { return id }
        let id = nextPointerID
        nextPointerID &+= 1
        pointerIDs[key] = id
        return id
    }

    private func down(_ key: ObjectIdentifier, _ p: CGPoint) {
        trackPointer(p)
        if stage.pointerDown(id: pointerID(key), x: p.x, y: p.y, width: bounds.width, height: bounds.height) {
            requestFrame()
        }
    }

    private func moved(_ key: ObjectIdentifier, _ p: CGPoint) {
        trackPointer(p)
        guard let id = pointerIDs[key] else { return }
        if stage.pointerMove(id: id, x: p.x, y: p.y) { requestFrame() }
    }

    private func up(_ key: ObjectIdentifier, _ p: CGPoint) {
        guard let id = pointerIDs.removeValue(forKey: key) else { return }
        stage.pointerUp(id: id, x: p.x, y: p.y)
        requestFrame()
    }

    private func cancel(_ key: ObjectIdentifier) {
        guard let id = pointerIDs.removeValue(forKey: key) else { return }
        stage.pointerCancel(id: id)
        requestFrame()
    }

    private func cancelPointers() {
        for id in pointerIDs.values { stage.pointerCancel(id: id) }
        pointerIDs = [:]
    }

    /// Effects that follow the pointer (live liquid metal) get its position; they keep drawing by
    /// themselves.
    private func trackPointer(_ p: CGPoint?) {
        guard let p, bounds.width > 0, bounds.height > 0 else { return stage.setPointer(nil) }
        stage.setPointer((p.x / bounds.width * 2 - 1, -(p.y / bounds.height) * 2 + 1))
    }

    private func updateAccessibility() {
        #if os(iOS)
        accessibilityValue = stage.accessibilityValue
        #else
        setAccessibilityValue(stage.accessibilityValue)
        #endif
    }

    #if os(iOS)
    // ── iOS ─────────────────────────────────────────────────────────────────

    override public class var layerClass: AnyClass { CAMetalLayer.self }

    private func setUp() {
        isOpaque = false
        backgroundColor = .clear
        isMultipleTouchEnabled = false
        metalLayer.isOpaque = false
        registerForTraitChanges([UITraitDisplayScale.self]) { (view: CardSurfaceView, _: UITraitCollection) in view.layoutDrawable() }
        isAccessibilityElement = true
        accessibilityLabel = stage.options.label
        accessibilityTraits = stage.options.interactive ? .button : .image
        if stage.options.interactive {
            accessibilityCustomActions = [UIAccessibilityCustomAction(name: "Reset") { [weak self] _ in
                self?.stage.reset()
                return true
            }]
        }
    }

    override public func accessibilityActivate() -> Bool {
        guard stage.options.interactive else { return false }
        stage.flip()
        return true
    }

    override public func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { startEngine() } else { link?.isPaused = true }
    }

    override public func layoutSubviews() {
        super.layoutSubviews()
        layoutDrawable()
    }

    override public func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { down(ObjectIdentifier(t), t.location(in: self)) }
    }

    override public func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { moved(ObjectIdentifier(t), t.location(in: self)) }
    }

    override public func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            up(ObjectIdentifier(t), t.location(in: self))
            // The second tap's release: the web's `dblclick`.
            if t.tapCount == 2 {
                stage.doubleClick()
                requestFrame()
            }
        }
        trackPointer(nil)
    }

    override public func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { cancel(ObjectIdentifier(t)) }
        trackPointer(nil)
    }

    override public func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for p in presses {
            switch p.key?.keyCode {
            case .keyboardEscape, .keyboardHome: handled = stage.key(reset: true) || handled
            case .keyboardReturnOrEnter, .keyboardSpacebar: handled = stage.key(reset: false) || handled
            default: break
            }
        }
        if handled { requestFrame() } else { super.pressesBegan(presses, with: event) }
    }

    override public var canBecomeFirstResponder: Bool { stage.options.interactive }

    #else
    // ── macOS ───────────────────────────────────────────────────────────────

    override public func makeBackingLayer() -> CALayer {
        let l = CAMetalLayer()
        l.isOpaque = false
        return l
    }

    override public var isFlipped: Bool { true }
    override public var acceptsFirstResponder: Bool { stage.options.interactive }
    override public func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private let mouse = ObjectIdentifier(NSEvent.self)

    private func setUp() {
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
        setAccessibilityElement(true)
        setAccessibilityRole(stage.options.interactive ? .button : .image)
        setAccessibilityLabel(stage.options.label)
        if stage.options.interactive {
            setAccessibilityCustomActions([NSAccessibilityCustomAction(name: "Reset") { [weak self] in
                self?.stage.reset()
                return true
            }])
        }
    }

    override public func accessibilityPerformPress() -> Bool {
        guard stage.options.interactive else { return false }
        stage.flip()
        return true
    }

    override public func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { startEngine() } else { link?.isPaused = true }
    }

    override public func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        layoutDrawable()
    }

    override public func setFrameSize(_ size: NSSize) {
        super.setFrameSize(size)
        layoutDrawable()
    }

    override public func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    private func point(_ e: NSEvent) -> CGPoint { convert(e.locationInWindow, from: nil) }

    override public func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        down(mouse, point(e))
    }

    override public func mouseDragged(with e: NSEvent) { moved(mouse, point(e)) }

    override public func mouseUp(with e: NSEvent) {
        up(mouse, point(e))
        // The second click's release: the web's `dblclick`.
        if e.clickCount == 2 {
            stage.doubleClick()
            requestFrame()
        }
    }

    override public func mouseMoved(with e: NSEvent) {
        trackPointer(point(e))
    }

    override public func mouseExited(with e: NSEvent) {
        trackPointer(nil)
    }

    override public func scrollWheel(with e: NSEvent) {
        let (dx, dy) = (Double(e.scrollingDeltaX), Double(e.scrollingDeltaY))
        stage.wheel(abs(dx) > abs(dy) ? -dx : -dy)
        requestFrame()
    }

    override public func keyDown(with e: NSEvent) {
        let reset = e.keyCode == 53 || e.specialKey == .home  // Escape, Home
        let flip = e.keyCode == 36 || e.keyCode == 76 || e.characters == " "  // Return, Enter, Space
        if (reset || flip) && stage.key(reset: reset) {
            requestFrame()
        } else {
            super.keyDown(with: e)
        }
    }
    #endif
}

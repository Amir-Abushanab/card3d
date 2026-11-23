import Card3D
import QuickLook
import SwiftUI

@main
struct Card3DExampleApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
        .defaultSize(width: 900, height: 700)
        #endif
    }
}

/// A bundled design (Presets/*.json).
struct Preset: Hashable, Identifiable {
    let id: String
    let title: String

    var url: URL? { Bundle.main.url(forResource: id, withExtension: "json") }

    static let all = [
        Preset(id: "brushed-silver", title: "Brushed silver"),
        Preset(id: "holo-front", title: "Holo foil"),
        Preset(id: "glass-clear", title: "Clear glass"),
        Preset(id: "scene-floor", title: "On a floor (scene)"),
        Preset(id: "face-halftone", title: "Halftone shader"),
        Preset(id: "sticker-gif", title: "GIF sticker"),
    ]

    /// `-preset <id>` on the command line picks the first design (screenshots).
    static var initial: Preset {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-preset"), i + 1 < args.count, let p = all.first(where: { $0.id == args[i + 1] }) { return p }
        return all[0]
    }
}

struct ContentView: View {
    @State private var stage = CardStage(options: .init(quality: .performance, fit: .contain, label: "Example card"))
    @State private var preset = Preset.initial
    @State private var preview: URL?
    @State private var message: String?

    private static let lightings = ["studio", "warm", "cool", "dramatic", "light", "dark"]

    var body: some View {
        VStack(spacing: 12) {
            CardView(stage: stage)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .top) {
                    if stage.isLoading { ProgressView().padding() }
                }

            if let message {
                Text(message).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }

            Picker("Design", selection: $preset) {
                ForEach(Preset.all) { Text($0.title).tag($0) }
            }

            HStack {
                Picker("Lighting", selection: Binding(get: { stage.lighting ?? "" }, set: { stage.lighting = $0.isEmpty ? nil : $0 })) {
                    Text("Design's").tag("")
                    ForEach(Self.lightings, id: \.self) { Text($0.capitalized).tag($0) }
                }
                Toggle("Full quality", isOn: Binding(get: { stage.quality == .full }, set: { stage.quality = $0 ? .full : .performance }))
            }

            HStack(spacing: 16) {
                Button("Flip") { stage.flip() }
                Button("Reset") { stage.reset() }
                Button("PNG") { exportPNG() }
                Button("AR") { exportAR() }
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .task(id: preset) { await load(preset) }
        .onChange(of: stage.lastError) { _, e in
            if let e { message = e.localizedDescription }
        }
        .quickLookPreview($preview)
    }

    private func load(_ preset: Preset) async {
        guard let url = preset.url else { return }
        do {
            let report = try await stage.setDesign(contentsOf: url)
            let notes = report.errors.count + report.warnings.count
            message = notes == 0 ? nil : "\(report.errors.count) errors, \(report.warnings.count) warnings in the design"
        } catch {
            message = error.localizedDescription
        }
    }

    private func exportPNG() {
        do {
            let png = try stage.exportPNG(width: 1600, height: 1000)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(preset.id).png")
            try png.write(to: url)
            preview = url
        } catch {
            message = error.localizedDescription
        }
    }

    /// USDZ in Quick Look: AR Quick Look on an iPhone or iPad.
    private func exportAR() {
        do {
            preview = try stage.exportARFile(.usdz, name: preset.id)
        } catch {
            message = error.localizedDescription
        }
    }
}

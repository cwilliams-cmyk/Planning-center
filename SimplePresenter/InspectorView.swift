import SwiftUI

/// The right pane: a live output preview on top, output-mode context, and the
/// slide / presentation inspector below.
struct RightPane: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var show: ShowController

    let selectedPresentationID: UUID?
    let selectedSlideID: UUID?

    var body: some View {
        VStack(spacing: 0) {
            livePreview
            Divider()
            inspector
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var livePreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle()
                    .fill(show.isOutputLive ? Color.red : Color.gray)
                    .frame(width: 8, height: 8)
                Text("LIVE")
                    .font(.caption.bold())
                    .foregroundColor(show.isOutputLive ? .red : .secondary)
                if show.mode != .live {
                    Text(show.mode.rawValue.uppercased())
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.25))
                        .cornerRadius(4)
                }
                Spacer()
                if show.livePlayer != nil {
                    Button {
                        show.restartVideo()
                    } label: {
                        Image(systemName: "backward.end.fill")
                    }
                    .buttonStyle(.plain)
                    .help("Restart video")
                }
            }

            OutputRootView()
                .aspectRatio(16.0 / 9.0, contentMode: .fit)
                .cornerRadius(6)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.gray.opacity(0.4)))
        }
        .padding(12)
    }

    @ViewBuilder
    private var inspector: some View {
        if let presentationID = selectedPresentationID,
           library.presentation(id: presentationID) != nil {
            InspectorView(presentationID: presentationID, slideID: selectedSlideID)
        } else {
            VStack {
                Spacer()
                Text("Nothing selected")
                    .foregroundColor(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
    }
}

struct InspectorView: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var show: ShowController

    let presentationID: UUID
    let slideID: UUID?

    @State private var scope: Scope = .slide

    enum Scope: String, CaseIterable, Identifiable {
        case slide = "Slide"
        case presentation = "Presentation"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $scope) {
                ForEach(Scope.allCases) { scope in
                    Text(scope.rawValue).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(12)

            ScrollView {
                switch scope {
                case .slide:
                    if let slideBinding {
                        SlideEditor(slide: slideBinding,
                                    presentation: presentationValue)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                    } else {
                        Text("Select a slide to edit it")
                            .foregroundColor(.secondary)
                            .padding()
                    }
                case .presentation:
                    PresentationEditor(presentation: presentationBinding)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
            }
        }
    }

    private var presentationValue: Presentation {
        library.presentation(id: presentationID) ?? Presentation(name: "")
    }

    private var presentationBinding: Binding<Presentation> {
        Binding(
            get: { library.presentation(id: presentationID) ?? Presentation(name: "") },
            set: { library.updatePresentation($0) }
        )
    }

    private var slideBinding: Binding<Slide>? {
        guard let slideID, library.slide(presentationID: presentationID, slideID: slideID) != nil else {
            return nil
        }
        return Binding(
            get: { library.slide(presentationID: presentationID, slideID: slideID) ?? Slide() },
            set: { library.updateSlide($0, presentationID: presentationID) }
        )
    }
}

// MARK: - Slide editor

struct SlideEditor: View {
    @Binding var slide: Slide
    let presentation: Presentation

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            InspectorSection("Text") {
                TextField("Label (e.g. Verse 1)", text: $slide.label)
                    .textFieldStyle(.roundedBorder)
                TextEditor(text: $slide.body)
                    .font(.system(size: 13))
                    .frame(minHeight: 110)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.gray.opacity(0.3)))
            }

            InspectorSection("Style") {
                Toggle("Custom style for this slide", isOn: styleOverrideEnabled)
                if slide.styleOverride != nil {
                    StyleEditor(style: overrideStyle)
                }
            }

            InspectorSection("Background") {
                Toggle("Custom background for this slide", isOn: backgroundOverrideEnabled)
                if slide.background != nil {
                    BackgroundEditor(background: overrideBackground)
                }
            }
        }
    }

    private var styleOverrideEnabled: Binding<Bool> {
        Binding(
            get: { slide.styleOverride != nil },
            set: { slide.styleOverride = $0 ? presentation.baseStyle : nil }
        )
    }

    private var overrideStyle: Binding<TextStyle> {
        Binding(
            get: { slide.styleOverride ?? presentation.baseStyle },
            set: { slide.styleOverride = $0 }
        )
    }

    private var backgroundOverrideEnabled: Binding<Bool> {
        Binding(
            get: { slide.background != nil },
            set: { slide.background = $0 ? presentation.background : nil }
        )
    }

    private var overrideBackground: Binding<SlideBackground> {
        Binding(
            get: { slide.background ?? presentation.background },
            set: { slide.background = $0 }
        )
    }
}

// MARK: - Presentation editor

struct PresentationEditor: View {
    @Binding var presentation: Presentation
    @EnvironmentObject private var show: ShowController

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            InspectorSection("Presentation") {
                TextField("Name", text: $presentation.name)
                    .textFieldStyle(.roundedBorder)
            }

            InspectorSection("Default Text Style") {
                StyleEditor(style: $presentation.baseStyle)
            }

            InspectorSection("Default Background") {
                BackgroundEditor(background: $presentation.background)
            }

            InspectorSection("Logo") {
                HStack {
                    Button("Choose Logo Image…") {
                        show.chooseLogo()
                    }
                    if let path = show.logoPath {
                        Text((path as NSString).lastPathComponent)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
                Text("Shown when you press L or click Logo.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
}

// MARK: - Reusable editors

struct StyleEditor: View {
    @Binding var style: TextStyle

    private var fontFamilies: [String] {
        NSFontManager.shared.availableFontFamilies.sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Font", selection: $style.fontName) {
                ForEach(fontFamilies, id: \.self) { family in
                    Text(family).tag(family)
                }
            }

            HStack {
                Text("Size")
                Slider(value: $style.fontSize, in: 30...260)
                Text("\(Int(style.fontSize))")
                    .font(.caption.monospacedDigit())
                    .frame(width: 34, alignment: .trailing)
            }

            HStack(spacing: 14) {
                Toggle("Bold", isOn: $style.isBold)
                Toggle("Caps", isOn: $style.allCaps)
                Toggle("Shadow", isOn: $style.hasShadow)
            }

            ColorPicker("Text Color", selection: colorBinding)

            Picker("Align", selection: $style.alignment) {
                ForEach(HAlignOption.allCases) { option in
                    Image(systemName: option.symbolName).tag(option)
                }
            }
            .pickerStyle(.segmented)

            Picker("Position", selection: $style.verticalAlignment) {
                ForEach(VAlignOption.allCases) { option in
                    Image(systemName: option.symbolName).tag(option)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var colorBinding: Binding<Color> {
        Binding(
            get: { style.color.color },
            set: { style.color = RGBAColor($0) }
        )
    }
}

struct BackgroundEditor: View {
    @Binding var background: SlideBackground

    private enum Kind: String, CaseIterable, Identifiable {
        case color = "Color"
        case image = "Image"
        case video = "Video"
        var id: String { rawValue }
    }

    private var kind: Kind {
        switch background {
        case .color: return .color
        case .image: return .image
        case .video: return .video
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("", selection: kindBinding) {
                ForEach(Kind.allCases) { kind in
                    Text(kind.rawValue).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            switch background {
            case .color:
                ColorPicker("Background Color", selection: colorBinding)

            case .image(let path):
                HStack {
                    Button("Choose Image…") {
                        if let url = MediaPicker.pickImage() {
                            background = .image(path: url.path)
                        }
                    }
                    fileName(path)
                }

            case .video(let path, let loops, let isMuted):
                HStack {
                    Button("Choose Video…") {
                        if let url = MediaPicker.pickVideo() {
                            background = .video(path: url.path, loops: loops, isMuted: isMuted)
                        }
                    }
                    fileName(path)
                }
                Toggle("Loop", isOn: Binding(
                    get: { loops },
                    set: { background = .video(path: path, loops: $0, isMuted: isMuted) }
                ))
                Toggle("Mute", isOn: Binding(
                    get: { isMuted },
                    set: { background = .video(path: path, loops: loops, isMuted: $0) }
                ))
            }
        }
    }

    @ViewBuilder
    private func fileName(_ path: String) -> some View {
        if path.isEmpty {
            Text("No file chosen")
                .font(.caption)
                .foregroundColor(.secondary)
        } else {
            Text((path as NSString).lastPathComponent)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(1)
        }
    }

    private var kindBinding: Binding<Kind> {
        Binding(
            get: { kind },
            set: { newKind in
                guard newKind != kind else { return }
                switch newKind {
                case .color: background = .color(.black)
                case .image: background = .image(path: "")
                case .video: background = .video(path: "", loops: true, isMuted: true)
                }
            }
        )
    }

    private var colorBinding: Binding<Color> {
        Binding(
            get: {
                if case let .color(rgba) = background { return rgba.color }
                return .black
            },
            set: { background = .color(RGBAColor($0)) }
        )
    }
}

/// A titled group used to organize the inspector.
struct InspectorSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption.bold())
                .foregroundColor(.secondary)
            content
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(8)
    }
}

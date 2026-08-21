import SwiftUI
import AppKit

// MARK: - Color

/// A Codable, sRGB color used throughout the data model.
struct RGBAColor: Codable, Hashable {
    var r: Double
    var g: Double
    var b: Double
    var a: Double

    init(r: Double, g: Double, b: Double, a: Double = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }

    init(_ color: Color) {
        let ns = NSColor(color).usingColorSpace(.sRGB) ?? .black
        self.init(r: Double(ns.redComponent),
                  g: Double(ns.greenComponent),
                  b: Double(ns.blueComponent),
                  a: Double(ns.alphaComponent))
    }

    var color: Color {
        Color(.sRGB, red: r, green: g, blue: b, opacity: a)
    }

    static let white = RGBAColor(r: 1, g: 1, b: 1)
    static let black = RGBAColor(r: 0, g: 0, b: 0)
    static let darkBlue = RGBAColor(r: 0.05, g: 0.09, b: 0.20)
}

// MARK: - Text style

enum HAlignOption: String, Codable, CaseIterable, Identifiable {
    case leading, center, trailing

    var id: String { rawValue }

    var textAlignment: TextAlignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    var horizontal: HorizontalAlignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    var symbolName: String {
        switch self {
        case .leading: return "text.alignleft"
        case .center: return "text.aligncenter"
        case .trailing: return "text.alignright"
        }
    }
}

enum VAlignOption: String, Codable, CaseIterable, Identifiable {
    case top, middle, bottom

    var id: String { rawValue }

    var vertical: VerticalAlignment {
        switch self {
        case .top: return .top
        case .middle: return .center
        case .bottom: return .bottom
        }
    }

    var symbolName: String {
        switch self {
        case .top: return "arrow.up.to.line"
        case .middle: return "arrow.up.and.down"
        case .bottom: return "arrow.down.to.line"
        }
    }
}

struct TextStyle: Codable, Hashable {
    var fontName: String = "Helvetica Neue"
    var fontSize: Double = 110
    var isBold: Bool = true
    var allCaps: Bool = false
    var hasShadow: Bool = true
    var color: RGBAColor = .white
    var alignment: HAlignOption = .center
    var verticalAlignment: VAlignOption = .middle

    var frameAlignment: Alignment {
        Alignment(horizontal: alignment.horizontal, vertical: verticalAlignment.vertical)
    }
}

// MARK: - Backgrounds

enum SlideBackground: Codable, Hashable {
    case color(RGBAColor)
    case image(path: String)
    case video(path: String, loops: Bool, isMuted: Bool)

    var videoPath: String? {
        if case let .video(path, _, _) = self { return path }
        return nil
    }
}

// MARK: - Slides & presentations

struct Slide: Identifiable, Codable, Hashable {
    var id = UUID()
    /// Section label, e.g. "Verse 1", "Chorus".
    var label: String = ""
    /// The text shown on screen. Empty for pure media slides.
    var body: String = ""
    /// Per-slide background; nil means "use the presentation background".
    var background: SlideBackground?
    /// Per-slide text style; nil means "use the presentation base style".
    var styleOverride: TextStyle?
}

struct Presentation: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var slides: [Slide] = []
    var baseStyle = TextStyle()
    var background: SlideBackground = .color(.black)

    func resolvedBackground(for slide: Slide) -> SlideBackground {
        slide.background ?? background
    }

    func resolvedStyle(for slide: Slide) -> TextStyle {
        slide.styleOverride ?? baseStyle
    }
}

struct Playlist: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var presentationIDs: [UUID] = []
}

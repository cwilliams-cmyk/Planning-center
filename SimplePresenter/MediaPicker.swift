import AppKit
import UniformTypeIdentifiers

/// Thin wrappers around NSOpenPanel for choosing media files.
enum MediaPicker {
    static func pickImage() -> URL? {
        pick(types: [.image], message: "Choose an image")
    }

    static func pickVideo() -> URL? {
        pick(types: [.movie, .video, .mpeg4Movie, .quickTimeMovie], message: "Choose a video")
    }

    private static func pick(types: [UTType], message: String) -> URL? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = types
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = message
        return panel.runModal() == .OK ? panel.url : nil
    }
}

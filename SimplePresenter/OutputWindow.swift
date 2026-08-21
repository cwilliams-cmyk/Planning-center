import SwiftUI
import AppKit

/// Manages the borderless, full-screen live output window on the chosen display.
final class OutputWindowManager {
    private var window: NSWindow?

    func show<Content: View>(on screen: NSScreen, content: Content) {
        hide()

        let window = NSWindow(contentRect: screen.frame,
                              styleMask: [.borderless],
                              backing: .buffered,
                              defer: false)
        window.isReleasedWhenClosed = false
        window.backgroundColor = .black
        window.level = .screenSaver // above the menu bar and Dock
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.contentView = NSHostingView(rootView: content)
        window.setFrame(screen.frame, display: true)
        window.orderFrontRegardless()
        self.window = window
    }

    func hide() {
        window?.orderOut(nil)
        window = nil
    }
}

/// The root view rendered inside the output window. Also reused (scaled down)
/// as the "Live" preview in the main window, so what you see is what the
/// audience sees.
struct OutputRootView: View {
    @EnvironmentObject private var show: ShowController
    @EnvironmentObject private var library: LibraryStore

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        switch show.mode {
        case .black:
            Color.black
        case .logo:
            if let path = show.logoPath, let image = NSImage(contentsOfFile: path) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(40)
            } else {
                Color.black
            }
        case .live, .clear:
            if let presentation = show.livePresentation, let slide = show.liveSlide {
                SlideRenderView(slide: slide,
                                presentation: presentation,
                                player: show.livePlayer,
                                hideText: show.mode == .clear)
            } else {
                Color.black
            }
        }
    }
}

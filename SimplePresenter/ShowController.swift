import SwiftUI
import AppKit
import AVFoundation

enum OutputMode: String {
    case live   // show the live slide
    case clear  // background only, no text
    case black  // black screen
    case logo   // show the logo image
}

/// Drives everything that is "on air": which slide is live, the output mode
/// (live / clear / black / logo), the video player for video backgrounds, and
/// the full-screen output window. Main-thread only (driven by the UI and the
/// key-event monitor, both of which run on the main thread).
final class ShowController: ObservableObject {
    let library: LibraryStore
    private let outputWindow = OutputWindowManager()

    @Published private(set) var livePresentationID: UUID?
    @Published private(set) var liveSlideIndex: Int = 0
    @Published var mode: OutputMode = .live
    @Published private(set) var isOutputLive = false
    @Published var selectedScreenIndex: Int
    @Published private(set) var livePlayer: AVPlayer?

    @Published var logoPath: String? {
        didSet { UserDefaults.standard.set(logoPath, forKey: "logoPath") }
    }

    private var looper: AVPlayerLooper?
    private var currentVideoPath: String?
    private var keyMonitor: Any?

    init(library: LibraryStore) {
        self.library = library
        self.logoPath = UserDefaults.standard.string(forKey: "logoPath")
        // Default to the second display when one is connected.
        self.selectedScreenIndex = NSScreen.screens.count > 1 ? 1 : 0
        installKeyMonitor()
    }

    // MARK: Live state

    var livePresentation: Presentation? {
        library.presentation(id: livePresentationID)
    }

    var liveSlide: Slide? {
        guard let presentation = livePresentation,
              presentation.slides.indices.contains(liveSlideIndex) else { return nil }
        return presentation.slides[liveSlideIndex]
    }

    func goLive(presentationID: UUID, slideIndex: Int) {
        guard let presentation = library.presentation(id: presentationID),
              presentation.slides.indices.contains(slideIndex) else { return }
        livePresentationID = presentationID
        liveSlideIndex = slideIndex
        mode = .live
        configurePlayer(for: presentation.slides[slideIndex], in: presentation)
    }

    func nextSlide() {
        guard let presentation = livePresentation else { return }
        let next = liveSlideIndex + 1
        guard presentation.slides.indices.contains(next) else { return }
        goLive(presentationID: presentation.id, slideIndex: next)
    }

    func previousSlide() {
        guard let presentation = livePresentation else { return }
        let previous = liveSlideIndex - 1
        guard presentation.slides.indices.contains(previous) else { return }
        goLive(presentationID: presentation.id, slideIndex: previous)
    }

    /// Toggles a mode: pressing Black while already black returns to live.
    func setMode(_ newMode: OutputMode) {
        mode = (mode == newMode) ? .live : newMode
    }

    // MARK: Video backgrounds

    private func configurePlayer(for slide: Slide, in presentation: Presentation) {
        let background = presentation.resolvedBackground(for: slide)
        guard case let .video(path, loops, isMuted) = background else {
            livePlayer?.pause()
            livePlayer = nil
            looper = nil
            currentVideoPath = nil
            return
        }

        // Keep the same player running when consecutive slides share a video
        // background (e.g. lyrics over a looping motion background).
        if path == currentVideoPath, let player = livePlayer {
            player.isMuted = isMuted
            if player.timeControlStatus != .playing { player.play() }
            return
        }

        let item = AVPlayerItem(url: URL(fileURLWithPath: path))
        let player = AVQueuePlayer()
        if loops {
            looper = AVPlayerLooper(player: player, templateItem: item)
        } else {
            looper = nil
            player.insert(item, after: nil)
        }
        player.isMuted = isMuted
        player.play()
        livePlayer = player
        currentVideoPath = path
    }

    /// Restarts the current video from the beginning.
    func restartVideo() {
        livePlayer?.seek(to: .zero)
        livePlayer?.play()
    }

    // MARK: Output window

    func toggleOutput() {
        if isOutputLive {
            outputWindow.hide()
            isOutputLive = false
        } else {
            let screens = NSScreen.screens
            let screen = screens.indices.contains(selectedScreenIndex)
                ? screens[selectedScreenIndex]
                : (NSScreen.main ?? screens.first)
            guard let screen else { return }
            let root = OutputRootView()
                .environmentObject(self)
                .environmentObject(library)
            outputWindow.show(on: screen, content: root)
            isOutputLive = true
        }
    }

    // MARK: Keyboard control

    /// Global (in-app) presentation keys, matching ProPresenter habits:
    /// arrows/space navigate, B/C/L toggle black/clear/logo.
    /// Ignored while the user is typing in a text field or editor.
    private func installKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            return self.handle(event) ? nil : event
        }
    }

    private func handle(_ event: NSEvent) -> Bool {
        // Don't steal keys from text editing or from modified shortcuts.
        if let responder = NSApp.keyWindow?.firstResponder, responder is NSTextView { return false }
        guard event.modifierFlags.intersection([.command, .option, .control]).isEmpty else { return false }

        switch event.keyCode {
        case 124, 125, 49: // right arrow, down arrow, space
            nextSlide()
            return true
        case 123, 126: // left arrow, up arrow
            previousSlide()
            return true
        default:
            break
        }

        switch event.charactersIgnoringModifiers?.lowercased() {
        case "b":
            setMode(.black)
            return true
        case "c":
            setMode(.clear)
            return true
        case "l":
            setMode(.logo)
            return true
        default:
            return false
        }
    }

    func chooseLogo() {
        if let url = MediaPicker.pickImage() {
            logoPath = url.path
        }
    }
}

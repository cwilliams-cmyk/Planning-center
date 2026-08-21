import SwiftUI
import AppKit

@main
struct SimplePresenterApp: App {
    @StateObject private var library: LibraryStore
    @StateObject private var show: ShowController

    init() {
        let library = LibraryStore()
        _library = StateObject(wrappedValue: library)
        _show = StateObject(wrappedValue: ShowController(library: library))

        // Ensures the app comes to the front even when launched via `swift run`.
        DispatchQueue.main.async {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    var body: some Scene {
        WindowGroup("SimplePresenter") {
            ContentView()
                .environmentObject(library)
                .environmentObject(show)
                .frame(minWidth: 1100, minHeight: 680)
        }
        .commands {
            LiveCommands(show: show)
        }
    }
}

struct LiveCommands: Commands {
    @ObservedObject var show: ShowController

    var body: some Commands {
        CommandMenu("Live") {
            Button("Next Slide  (→ / Space)") { show.nextSlide() }
            Button("Previous Slide  (←)") { show.previousSlide() }
            Divider()
            Button("Black Screen  (B)") { show.setMode(.black) }
            Button("Clear Text  (C)") { show.setMode(.clear) }
            Button("Show Logo  (L)") { show.setMode(.logo) }
            Divider()
            Button(show.isOutputLive ? "Stop Output" : "Start Output") {
                show.toggleOutput()
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
        }
    }
}

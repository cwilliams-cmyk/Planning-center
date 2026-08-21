import SwiftUI
import AppKit

struct ContentView: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var show: ShowController

    @State private var selectedPresentationID: UUID?
    @State private var selectedSlideID: UUID?
    @State private var showingNewSong = false

    var body: some View {
        NavigationSplitView {
            SidebarView(selectedPresentationID: $selectedPresentationID)
                .navigationSplitViewColumnWidth(min: 200, ideal: 230)
        } content: {
            SlideGridView(presentationID: selectedPresentationID,
                          selectedSlideID: $selectedSlideID)
                .navigationSplitViewColumnWidth(min: 420, ideal: 640)
        } detail: {
            RightPane(selectedPresentationID: selectedPresentationID,
                      selectedSlideID: selectedSlideID)
                .navigationSplitViewColumnWidth(min: 320, ideal: 360)
        }
        .onChange(of: selectedPresentationID) { _ in
            selectedSlideID = nil
        }
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    showingNewSong = true
                } label: {
                    Label("New Song", systemImage: "music.note.list")
                }
                .help("Create a song by pasting lyrics")

                Button {
                    addVideoItem()
                } label: {
                    Label("Add Video", systemImage: "film.fill")
                }
                .help("Add a video as a presentation item")

                Button {
                    addBlankPresentation()
                } label: {
                    Label("New Presentation", systemImage: "plus.rectangle.on.rectangle")
                }
                .help("Create a blank presentation")
            }

            ToolbarItemGroup(placement: .primaryAction) {
                ModeButtons()

                Menu {
                    ForEach(Array(NSScreen.screens.enumerated()), id: \.offset) { index, screen in
                        Button {
                            show.selectedScreenIndex = index
                        } label: {
                            if index == show.selectedScreenIndex {
                                Label(screen.localizedName, systemImage: "checkmark")
                            } else {
                                Text(screen.localizedName)
                            }
                        }
                    }
                } label: {
                    Label("Display", systemImage: "display.2")
                }
                .help("Choose which display the output appears on")

                Button {
                    show.toggleOutput()
                } label: {
                    if show.isOutputLive {
                        Label("Stop Output", systemImage: "stop.circle.fill")
                            .foregroundColor(.red)
                    } else {
                        Label("Start Output", systemImage: "play.display")
                    }
                }
                .help("Show or hide the full-screen output (⇧⌘O)")
            }
        }
        .sheet(isPresented: $showingNewSong) {
            NewSongSheet { newID in
                selectedPresentationID = newID
            }
        }
    }

    private func addVideoItem() {
        guard let url = MediaPicker.pickVideo() else { return }
        var presentation = Presentation(name: url.deletingPathExtension().lastPathComponent)
        presentation.background = .video(path: url.path, loops: false, isMuted: false)
        presentation.slides = [Slide()]
        library.addPresentation(presentation)
        selectedPresentationID = presentation.id
    }

    private func addBlankPresentation() {
        var presentation = Presentation(name: "New Presentation")
        presentation.slides = [Slide()]
        library.addPresentation(presentation)
        selectedPresentationID = presentation.id
    }
}

/// The Clear / Black / Logo controls, highlighted when active.
struct ModeButtons: View {
    @EnvironmentObject private var show: ShowController

    var body: some View {
        HStack(spacing: 4) {
            modeButton(.clear, title: "Clear", icon: "textformat.abc.dottedunderline", help: "Hide text, keep background (C)")
            modeButton(.black, title: "Black", icon: "rectangle.fill", help: "Black screen (B)")
            modeButton(.logo, title: "Logo", icon: "seal", help: "Show logo (L)")
        }
    }

    private func modeButton(_ mode: OutputMode, title: String, icon: String, help: String) -> some View {
        Button {
            show.setMode(mode)
        } label: {
            Label(title, systemImage: icon)
        }
        .help(help)
        .background(show.mode == mode ? Color.accentColor.opacity(0.35) : Color.clear)
        .cornerRadius(6)
    }
}

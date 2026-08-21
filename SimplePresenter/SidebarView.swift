import SwiftUI

struct SidebarView: View {
    @EnvironmentObject private var library: LibraryStore
    @Binding var selectedPresentationID: UUID?

    @State private var newPlaylistName = ""
    @State private var showingNewPlaylist = false

    var body: some View {
        List(selection: $selectedPresentationID) {
            Section {
                ForEach(library.playlists) { playlist in
                    DisclosureGroup {
                        ForEach(playlist.presentationIDs, id: \.self) { presentationID in
                            if let presentation = library.presentation(id: presentationID) {
                                presentationRow(presentation)
                                    .tag(presentation.id)
                                    .contextMenu {
                                        Button("Remove from Playlist") {
                                            library.remove(presentationID: presentation.id,
                                                           fromPlaylist: playlist.id)
                                        }
                                    }
                            }
                        }
                    } label: {
                        Label(playlist.name, systemImage: "music.note.list")
                            .contextMenu {
                                Button("Delete Playlist", role: .destructive) {
                                    library.deletePlaylist(id: playlist.id)
                                }
                            }
                    }
                }
            } header: {
                HStack {
                    Text("Playlists")
                    Spacer()
                    Button {
                        showingNewPlaylist = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.plain)
                    .help("New playlist")
                }
            }

            Section("Library") {
                ForEach(library.presentations) { presentation in
                    presentationRow(presentation)
                        .tag(presentation.id)
                        .contextMenu {
                            if !library.playlists.isEmpty {
                                Menu("Add to Playlist") {
                                    ForEach(library.playlists) { playlist in
                                        Button(playlist.name) {
                                            library.add(presentationID: presentation.id,
                                                        toPlaylist: playlist.id)
                                        }
                                    }
                                }
                            }
                            Button("Duplicate") {
                                library.duplicatePresentation(id: presentation.id)
                            }
                            Button("Delete", role: .destructive) {
                                if selectedPresentationID == presentation.id {
                                    selectedPresentationID = nil
                                }
                                library.deletePresentation(id: presentation.id)
                            }
                        }
                }
            }
        }
        .listStyle(.sidebar)
        .alert("New Playlist", isPresented: $showingNewPlaylist) {
            TextField("Name", text: $newPlaylistName)
            Button("Create") {
                let name = newPlaylistName.trimmingCharacters(in: .whitespaces)
                library.addPlaylist(named: name.isEmpty ? "New Playlist" : name)
                newPlaylistName = ""
            }
            Button("Cancel", role: .cancel) {
                newPlaylistName = ""
            }
        }
    }

    private func presentationRow(_ presentation: Presentation) -> some View {
        Label {
            Text(presentation.name)
                .lineLimit(1)
        } icon: {
            Image(systemName: presentation.background.videoPath != nil ? "film" : "doc.text.image")
        }
    }
}

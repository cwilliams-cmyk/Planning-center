import SwiftUI

/// Paste lyrics, get slides. Blank lines split slides; "[Verse 1]" or
/// "Chorus:" lines become slide labels.
struct NewSongSheet: View {
    @EnvironmentObject private var library: LibraryStore
    @Environment(\.dismiss) private var dismiss

    var onCreated: (UUID) -> Void

    @State private var name = ""
    @State private var lyrics = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Song from Lyrics")
                .font(.title3.bold())

            TextField("Song title", text: $name)
                .textFieldStyle(.roundedBorder)

            Text("Paste lyrics below. Blank lines start a new slide. Lines like “[Verse 1]” or “Chorus” label the next slide.")
                .font(.caption)
                .foregroundColor(.secondary)

            TextEditor(text: $lyrics)
                .font(.system(size: 13, design: .monospaced))
                .frame(minHeight: 260)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.gray.opacity(0.3)))

            HStack {
                let slideCount = LibraryStore.slides(fromLyrics: lyrics).count
                Text(slideCount == 1 ? "1 slide" : "\(slideCount) slides")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("Create Song") {
                    create()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(lyrics.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func create() {
        let title = name.trimmingCharacters(in: .whitespaces)
        var song = Presentation(name: title.isEmpty ? "New Song" : title)
        song.slides = LibraryStore.slides(fromLyrics: lyrics)
        if song.slides.isEmpty {
            song.slides = [Slide()]
        }
        library.addPresentation(song)
        onCreated(song.id)
        dismiss()
    }
}

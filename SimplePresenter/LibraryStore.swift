import Foundation
import Combine

/// Owns every presentation and playlist and persists them as JSON in
/// ~/Library/Application Support/SimplePresenter/library.json.
/// Main-thread only (driven entirely by the UI).
final class LibraryStore: ObservableObject {
    @Published var presentations: [Presentation] = []
    @Published var playlists: [Playlist] = []

    private var cancellables = Set<AnyCancellable>()

    private static var saveURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("SimplePresenter/library.json")
    }

    private struct LibraryFile: Codable {
        var presentations: [Presentation]
        var playlists: [Playlist]
    }

    init() {
        load()
        if presentations.isEmpty {
            seedSampleContent()
            save()
        }

        Publishers.CombineLatest($presentations, $playlists)
            .dropFirst()
            .debounce(for: .seconds(0.5), scheduler: RunLoop.main)
            .sink { [weak self] _, _ in self?.save() }
            .store(in: &cancellables)
    }

    // MARK: Persistence

    private func load() {
        guard let data = try? Data(contentsOf: Self.saveURL),
              let file = try? JSONDecoder().decode(LibraryFile.self, from: data) else { return }
        presentations = file.presentations
        playlists = file.playlists
    }

    func save() {
        let url = Self.saveURL
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(LibraryFile(presentations: presentations, playlists: playlists))
            try data.write(to: url, options: .atomic)
        } catch {
            NSLog("SimplePresenter: failed to save library: \(error)")
        }
    }

    // MARK: Presentation lookup & editing

    func presentation(id: UUID?) -> Presentation? {
        guard let id else { return nil }
        return presentations.first { $0.id == id }
    }

    func updatePresentation(_ presentation: Presentation) {
        guard let index = presentations.firstIndex(where: { $0.id == presentation.id }) else { return }
        presentations[index] = presentation
    }

    func addPresentation(_ presentation: Presentation) {
        presentations.append(presentation)
    }

    func deletePresentation(id: UUID) {
        presentations.removeAll { $0.id == id }
        for index in playlists.indices {
            playlists[index].presentationIDs.removeAll { $0 == id }
        }
    }

    func duplicatePresentation(id: UUID) {
        guard var copy = presentation(id: id),
              let index = presentations.firstIndex(where: { $0.id == id }) else { return }
        copy.id = UUID()
        copy.name += " Copy"
        copy.slides = copy.slides.map { slide in
            var s = slide
            s.id = UUID()
            return s
        }
        presentations.insert(copy, at: index + 1)
    }

    // MARK: Slide editing

    func slide(presentationID: UUID, slideID: UUID) -> Slide? {
        presentation(id: presentationID)?.slides.first { $0.id == slideID }
    }

    func updateSlide(_ slide: Slide, presentationID: UUID) {
        guard let pIndex = presentations.firstIndex(where: { $0.id == presentationID }),
              let sIndex = presentations[pIndex].slides.firstIndex(where: { $0.id == slide.id }) else { return }
        presentations[pIndex].slides[sIndex] = slide
    }

    @discardableResult
    func addSlide(to presentationID: UUID, after slideID: UUID? = nil) -> Slide? {
        guard let pIndex = presentations.firstIndex(where: { $0.id == presentationID }) else { return nil }
        let slide = Slide()
        if let slideID,
           let sIndex = presentations[pIndex].slides.firstIndex(where: { $0.id == slideID }) {
            presentations[pIndex].slides.insert(slide, at: sIndex + 1)
        } else {
            presentations[pIndex].slides.append(slide)
        }
        return slide
    }

    func deleteSlide(id: UUID, presentationID: UUID) {
        guard let pIndex = presentations.firstIndex(where: { $0.id == presentationID }) else { return }
        presentations[pIndex].slides.removeAll { $0.id == id }
    }

    func duplicateSlide(id: UUID, presentationID: UUID) {
        guard let pIndex = presentations.firstIndex(where: { $0.id == presentationID }),
              let sIndex = presentations[pIndex].slides.firstIndex(where: { $0.id == id }) else { return }
        var copy = presentations[pIndex].slides[sIndex]
        copy.id = UUID()
        presentations[pIndex].slides.insert(copy, at: sIndex + 1)
    }

    func moveSlide(id: UUID, presentationID: UUID, offset: Int) {
        guard let pIndex = presentations.firstIndex(where: { $0.id == presentationID }),
              let sIndex = presentations[pIndex].slides.firstIndex(where: { $0.id == id }) else { return }
        let target = sIndex + offset
        guard presentations[pIndex].slides.indices.contains(target) else { return }
        presentations[pIndex].slides.swapAt(sIndex, target)
    }

    // MARK: Playlists

    func addPlaylist(named name: String) {
        playlists.append(Playlist(name: name))
    }

    func deletePlaylist(id: UUID) {
        playlists.removeAll { $0.id == id }
    }

    func add(presentationID: UUID, toPlaylist playlistID: UUID) {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }),
              !playlists[index].presentationIDs.contains(presentationID) else { return }
        playlists[index].presentationIDs.append(presentationID)
    }

    func remove(presentationID: UUID, fromPlaylist playlistID: UUID) {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        playlists[index].presentationIDs.removeAll { $0 == presentationID }
    }

    // MARK: Lyric import

    /// Splits pasted lyrics into slides. Blank lines separate slides.
    /// A line like "[Verse 1]" or "Chorus:" becomes the label of the following slide.
    static func slides(fromLyrics text: String) -> [Slide] {
        let sectionWords = ["verse", "chorus", "bridge", "tag", "intro", "outro",
                            "pre-chorus", "prechorus", "refrain", "ending", "interlude", "vamp"]
        var slides: [Slide] = []
        var pendingLabel = ""
        var currentLines: [String] = []

        func flush() {
            let body = currentLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty {
                slides.append(Slide(label: pendingLabel, body: body))
                pendingLabel = ""
            }
            currentLines = []
        }

        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                flush()
                continue
            }

            // Bracketed labels: [Verse 1]
            if line.hasPrefix("["), line.hasSuffix("]"), line.count > 2 {
                flush()
                pendingLabel = String(line.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
                continue
            }

            // Bare section headers: "Verse 1", "Chorus:", etc.
            let normalized = line.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            let firstWord = normalized.components(separatedBy: " ").first ?? normalized
            let rest = normalized.dropFirst(firstWord.count).trimmingCharacters(in: .whitespaces)
            let restIsNumberOrEmpty = rest.isEmpty || Int(rest) != nil
            if sectionWords.contains(firstWord), restIsNumberOrEmpty, line.count <= 20 {
                flush()
                pendingLabel = line.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
                continue
            }

            currentLines.append(line)
        }
        flush()
        return slides
    }

    // MARK: Sample content

    private func seedSampleContent() {
        var welcome = Presentation(name: "Welcome to SimplePresenter")
        welcome.background = .color(.darkBlue)
        welcome.baseStyle.fontSize = 90
        welcome.slides = [
            Slide(label: "Welcome",
                  body: "Welcome to\nSimplePresenter"),
            Slide(label: "Basics",
                  body: "Click a slide to send it live.\nArrow keys / space move\nthrough slides."),
            Slide(label: "Keys",
                  body: "B = black screen\nC = clear text\nL = show logo"),
            Slide(label: "Output",
                  body: "Use Start Output in the toolbar\nto light up your second display."),
        ]

        let amazingGraceLyrics = """
        [Verse 1]
        Amazing grace, how sweet the sound
        That saved a wretch like me
        I once was lost, but now am found
        Was blind, but now I see

        [Verse 2]
        'Twas grace that taught my heart to fear
        And grace my fears relieved
        How precious did that grace appear
        The hour I first believed
        """
        var song = Presentation(name: "Amazing Grace")
        song.slides = Self.slides(fromLyrics: amazingGraceLyrics)

        presentations = [welcome, song]

        var sunday = Playlist(name: "Sunday Service")
        sunday.presentationIDs = [welcome.id, song.id]
        playlists = [sunday]
    }
}

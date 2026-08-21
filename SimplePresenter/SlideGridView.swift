import SwiftUI

/// The center pane: a grid of slide thumbnails for the selected presentation.
/// Clicking a slide selects it for editing AND sends it live, like ProPresenter.
struct SlideGridView: View {
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var show: ShowController

    let presentationID: UUID?
    @Binding var selectedSlideID: UUID?

    private let columns = [GridItem(.adaptive(minimum: 190, maximum: 300), spacing: 14)]

    var body: some View {
        if let presentation = library.presentation(id: presentationID) {
            VStack(spacing: 0) {
                header(presentation)
                Divider()
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(Array(presentation.slides.enumerated()), id: \.element.id) { index, slide in
                            slideCell(slide, index: index, presentation: presentation)
                        }
                    }
                    .padding(14)
                }
            }
            .background(Color(nsColor: .windowBackgroundColor))
        } else {
            VStack(spacing: 12) {
                Image(systemName: "rectangle.on.rectangle.slash")
                    .font(.system(size: 44))
                    .foregroundColor(.secondary)
                Text("Select a presentation")
                    .foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func header(_ presentation: Presentation) -> some View {
        HStack {
            Text(presentation.name)
                .font(.headline)
                .lineLimit(1)
            Spacer()
            Button {
                if let slide = library.addSlide(to: presentation.id, after: selectedSlideID) {
                    selectedSlideID = slide.id
                }
            } label: {
                Label("Add Slide", systemImage: "plus")
            }
            .help("Add a slide after the selected one")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private func slideCell(_ slide: Slide, index: Int, presentation: Presentation) -> some View {
        let isLive = show.livePresentationID == presentation.id
            && show.liveSlideIndex == index
            && show.mode == .live
        let isSelected = selectedSlideID == slide.id

        return VStack(spacing: 5) {
            SlideRenderView(slide: slide, presentation: presentation)
                .aspectRatio(16.0 / 9.0, contentMode: .fit)
                .cornerRadius(6)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(isLive ? Color.orange : (isSelected ? Color.accentColor : Color.gray.opacity(0.35)),
                                lineWidth: isLive || isSelected ? 3 : 1)
                )

            HStack {
                Text("\(index + 1)")
                    .font(.caption.monospacedDigit())
                    .foregroundColor(.secondary)
                if !slide.label.isEmpty {
                    Text(slide.label)
                        .font(.caption.bold())
                        .lineLimit(1)
                        .foregroundColor(isLive ? .orange : .primary)
                }
                Spacer()
            }
            .padding(.horizontal, 2)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            selectedSlideID = slide.id
            show.goLive(presentationID: presentation.id, slideIndex: index)
        }
        .contextMenu {
            Button("Duplicate") {
                library.duplicateSlide(id: slide.id, presentationID: presentation.id)
            }
            Button("Move Earlier") {
                library.moveSlide(id: slide.id, presentationID: presentation.id, offset: -1)
            }
            Button("Move Later") {
                library.moveSlide(id: slide.id, presentationID: presentation.id, offset: 1)
            }
            Divider()
            Button("Delete", role: .destructive) {
                if selectedSlideID == slide.id { selectedSlideID = nil }
                library.deleteSlide(id: slide.id, presentationID: presentation.id)
            }
        }
    }
}

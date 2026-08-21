import SwiftUI
import AppKit
import AVFoundation

/// Renders one slide on a fixed 1920x1080 design canvas, then scales it to fit
/// whatever space it is given. The same view draws thumbnails, previews, and
/// the full-screen output, so every context is pixel-consistent.
struct SlideRenderView: View {
    let slide: Slide
    let presentation: Presentation
    var player: AVPlayer?
    var hideText: Bool = false

    private static let canvas = CGSize(width: 1920, height: 1080)

    var body: some View {
        GeometryReader { geo in
            let scale = min(geo.size.width / Self.canvas.width,
                            geo.size.height / Self.canvas.height)
            ZStack {
                backgroundView
                if !hideText {
                    textView
                }
            }
            .frame(width: Self.canvas.width, height: Self.canvas.height)
            .clipped()
            .scaleEffect(scale)
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    @ViewBuilder
    private var backgroundView: some View {
        switch presentation.resolvedBackground(for: slide) {
        case .color(let rgba):
            rgba.color
        case .image(let path):
            if let image = NSImage(contentsOfFile: path) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: Self.canvas.width, height: Self.canvas.height)
                    .clipped()
            } else {
                missingMediaView(name: (path as NSString).lastPathComponent, icon: "photo")
            }
        case .video(let path, _, _):
            if let player {
                PlayerLayerView(player: player)
            } else {
                // Thumbnails and previews show a placeholder instead of a
                // second running copy of the video.
                missingMediaView(name: (path as NSString).lastPathComponent, icon: "film")
            }
        }
    }

    private func missingMediaView(name: String, icon: String) -> some View {
        ZStack {
            Color(.sRGB, red: 0.12, green: 0.12, blue: 0.14)
            VStack(spacing: 24) {
                Image(systemName: icon)
                    .font(.system(size: 160))
                Text(name)
                    .font(.system(size: 48))
                    .lineLimit(1)
            }
            .foregroundColor(.white.opacity(0.4))
        }
    }

    private var textView: some View {
        let style = presentation.resolvedStyle(for: slide)
        let text = style.allCaps ? slide.body.uppercased() : slide.body
        return Text(text)
            .font(.custom(style.fontName, size: style.fontSize))
            .fontWeight(style.isBold ? .bold : .regular)
            .foregroundColor(style.color.color)
            .multilineTextAlignment(style.alignment.textAlignment)
            .minimumScaleFactor(0.3)
            .shadow(color: style.hasShadow ? .black.opacity(0.75) : .clear,
                    radius: 10, x: 0, y: 5)
            .padding(80)
            .frame(width: Self.canvas.width, height: Self.canvas.height,
                   alignment: style.frameAlignment)
    }
}

/// An AVPlayerLayer host so video backgrounds fill the frame edge-to-edge
/// (VideoPlayer would draw playback controls).
struct PlayerLayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> PlayerBackedView {
        let view = PlayerBackedView()
        view.playerLayer.player = player
        return view
    }

    func updateNSView(_ nsView: PlayerBackedView, context: Context) {
        if nsView.playerLayer.player !== player {
            nsView.playerLayer.player = player
        }
    }
}

final class PlayerBackedView: NSView {
    let playerLayer = AVPlayerLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        playerLayer.videoGravity = .resizeAspectFill
        layer?.addSublayer(playerLayer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = bounds
        CATransaction.commit()
    }
}

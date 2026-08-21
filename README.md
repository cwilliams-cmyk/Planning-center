# SimplePresenter

A native macOS presentation app in the spirit of ProPresenter, but radically
simpler: make lyric slides fast, drop in videos when you need them, and put a
clean full-screen output on your second display.

Built with SwiftUI + AVFoundation. No accounts, no subscriptions, no internet
required. Your whole library is one JSON file you can back up.

## What it does

- **Slide making, fast** — paste lyrics into *New Song* and blank lines become
  slides automatically. Lines like `[Verse 1]` or `Chorus` become slide labels.
- **Video embedding** — use a video as a slide/presentation background (looping
  motion backgrounds behind lyrics, muted or not), or add a standalone video
  item with the *Add Video* toolbar button. Sequential slides that share the
  same video background keep the video playing without restarting.
- **Image and color backgrounds** — per presentation, with per-slide overrides.
- **Text styling** — font, size, bold, all-caps, shadow, color, horizontal and
  vertical alignment; set a default style per presentation and override any
  individual slide.
- **Live output** — a borderless full-screen output window on any connected
  display (pick the display from the toolbar). The main window shows a live
  preview of exactly what the audience sees.
- **Presenter controls** (ProPresenter muscle memory):
  - Click a slide → it goes live
  - `→` / `↓` / `Space` — next slide, `←` / `↑` — previous slide
  - `B` — black screen, `C` — clear text (keep background), `L` — show logo
  - `⇧⌘O` — start/stop the output window
  - Pressing `B`/`C`/`L` again returns to the live slide
- **Playlists** — organize presentations into a service order in the sidebar.
- **Autosave** — everything persists to
  `~/Library/Application Support/SimplePresenter/library.json`.

## Running it (Mac)

You need Xcode (free from the Mac App Store).

### Easiest: open the folder in Xcode

1. Clone this repo.
2. In Xcode: **File → Open…** and choose the repo folder (it opens as a Swift
   package).
3. Select the **SimplePresenter** scheme, **My Mac** as the destination, press
   **Run** (⌘R).

Or from Terminal: `swift run` in the repo folder.

### For a real .app bundle: XcodeGen

```bash
brew install xcodegen
cd Planning-center
xcodegen
open SimplePresenter.xcodeproj
```

Press Run, or **Product → Archive** to export an app you can keep in
`/Applications` on the presentation Mac.

## Sunday-morning workflow

1. **New Song** → paste lyrics from Planning Center / SongSelect → Create.
2. Select the song, open the **Presentation** tab in the right pane, set a
   background (try a looping, muted motion video) and text style once — every
   slide inherits it.
3. Drag through your set: add each song to a **playlist** (right-click → Add to
   Playlist) so the service order lives in the sidebar.
4. Plug in the projector/HDMI, pick the display from the toolbar **Display**
   menu, hit **Start Output**.
5. Click slides or ride the arrow keys. `B` for black during prayer, `L` for
   your logo during announcements.

## Project layout

| File | Role |
| --- | --- |
| `SimplePresenter/Models.swift` | Slides, presentations, playlists, styles, backgrounds (all Codable) |
| `SimplePresenter/LibraryStore.swift` | Persistence, CRUD, lyric-to-slides parser, sample content |
| `SimplePresenter/ShowController.swift` | Live state, video players, keyboard control, output toggling |
| `SimplePresenter/OutputWindow.swift` | Full-screen output window + the shared output view |
| `SimplePresenter/SlideRenderView.swift` | WYSIWYG slide renderer (1920×1080 canvas scaled everywhere) |
| `SimplePresenter/ContentView.swift` | Main three-pane window and toolbar |
| `SimplePresenter/SidebarView.swift` | Playlists + library sidebar |
| `SimplePresenter/SlideGridView.swift` | Slide thumbnail grid (click = go live) |
| `SimplePresenter/InspectorView.swift` | Live preview pane + slide/presentation inspector |
| `SimplePresenter/NewSongSheet.swift` | Paste-lyrics song creator |

## Notes & roadmap

- Media files (videos, images, logo) are referenced by path, not copied — keep
  them in a stable folder (e.g. `~/Movies/Backgrounds`).
- Ideas for next steps: Planning Center Online import, stage display
  (next-slide + clock), Bible verse insertion, slide transitions, audio cues,
  drag-and-drop reordering, remote control from a phone.

# PTZ Control — Operator Guide

A quick guide for camera operators. You cannot break the live video from
this app: it sends camera-*control* commands only, and the video feeding
the YoloBox/recorder continues on its own even if this app is closed.

## The two modes (top of the window)

- **Live Control** — what you use during a service. Only safe operations
  are possible: move cameras, zoom, focus, recall presets, gentle image
  tweaks. You cannot accidentally delete a camera or overwrite a preset.
- **Setup** — before the service. Scan for cameras, add/rename/remove
  cameras, and edit presets. The app never switches to Setup by itself.

## Adding a camera (before service)

1. Click **Setup**.
2. Click **Scan network** — cameras on the same network appear by
   themselves — or click **+ Add camera** and type the camera's IP address.
3. Rename it something obvious (✎ on its tile): "Stage Left", "Balcony".
4. Click **Live Control** when you're done.

Cameras are remembered permanently, even while they're powered off.

## Is my camera connected?

Each camera tile has a colored dot and a status line:

- 🟢 **Connected** — you're in control.
- 🟡 **Intermittent** — control may lag for a moment; video is unaffected.
- 🟡 **Connecting…** (pulsing) — the app is reaching out to the camera.
- 🔴 **Control offline** — the app can't reach the camera's controls.
  **The camera's video keeps going to the recorder on its own.** The app
  reconnects automatically when the camera is reachable again — there is
  nothing you need to click.

## Moving the camera

1. Click the camera's tile (blue border = selected).
2. Hold the arrow pad to pan/tilt — **release to stop**. Same for Zoom −/+
   and Focus −/+.
3. Pick **Slow / Normal / Fast** for movement speed. Slow is smoothest on
   a live shot.
4. Keyboard: arrow keys move, `+`/`−` zoom, `H` home, `1`–`9` presets, and
   **Space stops every camera immediately**.

Focus: leave **Auto** on unless you have a reason not to. If you switch to
**Manual**, a yellow note reminds you the camera will not refocus by itself.

## Presets

- **Recall** (during service): click a preset button — the camera moves
  there. That's it; recalling is always safe.
- **Save/rename** (before service): in **Setup** mode, tick **Edit
  presets**. Clicking a preset now saves the camera's *current* position
  into it (it asks first). ✎ renames a preset — use names volunteers
  recognize: *Wide Stage, Pulpit, Worship Leader, Keys, Drums, Baptism,
  Congregation, Sermon Two-Shot*.
- Each camera has its own presets 1–9.

## If something looks stuck

- A red **Control offline** tile is not an emergency: video is unaffected.
  Check the camera's power and network cable; the app reconnects on its
  own, or click **Retry control connection** right on the tile.
- A camera that's being worked on can be **Disabled** (Setup mode): the app
  stops talking to it entirely until you enable it again. Its name and
  presets are kept.
- **Lock** (top right) freezes all controls while keeping status visible —
  useful if you need to step away.
- Worried a camera is moving when it shouldn't? Press **Space** — stop is
  sent to every camera.
- **Camera ignores pan/tilt?** If AI Tracking was turned on from the
  camera's own remote or web page (so this app doesn't know), the Astra P1
  ignores manual pan/tilt by design. Press **Stop Tracking & Take Manual
  Control** in the panel, or turn tracking off on the camera.

## AI Tracking

The **AI Tracking** section in the control panel starts and stops the
camera's subject tracking:

- **Start AI Tracking** — the camera follows the subject on its own. The
  panel shows **Tracking Active**, and the pan/tilt pad is locked because
  the camera ignores manual pan/tilt while tracking (zoom, presets, and
  Stop still work).
- **Stop Tracking & Take Manual Control** — one click returns the camera
  to you.
- Recalling a preset while tracking asks first, then stops tracking and
  recalls.
- **Test it before service** (Setup mode): if Start AI Tracking has no
  effect on your camera, open the camera tile's settings in Setup mode and
  switch **Tracking command** to *Recall preset 80/81*, then test again.
  (Hollyland hasn't published the P1's command list, so PTZ Control
  supports both conventions used by cameras of this type. If you use the
  preset method, don't save your own shots into presets 80/81.)
- Choosing *Presenter* vs *Zone* tracking and drawing zones (up to four)
  is done once, in the camera's own web page — before service.

## Nice extras (Setup mode)

- **Image freeze during preset recall** (checkbox under each camera tile):
  holds the current frame on the camera's output while it physically moves
  to a preset, so viewers don't see the swing. It resumes automatically a
  couple of seconds later. Try it before a service to confirm your camera
  supports it.
- **Reorder presets**: in Edit presets, use ◀ ▶ to arrange the grid the way
  your service flows. This changes layout only, never the saved positions.
- **Exact speed**: next to Slow/Normal/Fast there's a small number box
  (1–24) for a precise speed; clicking Slow/Normal/Fast takes over again.

## Previews

The small video tiles are optional, low-bandwidth previews, separate from
the recording feed. They're off by default during Live Control to keep the
production network quiet; turn them on with the **Previews** checkbox if
you want them. Control works fully without them.

## Diagnostics

Click **Diagnostics** for each camera's connection state and a log of
recent events. **Copy support info** puts a text report on the clipboard —
paste it into a message when asking for help. It contains no passwords.

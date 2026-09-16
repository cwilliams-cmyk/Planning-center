# Astra PTZ Control

A multi-camera dashboard for **Hollyland Astra** PTZ cameras (and any other
VISCA-over-IP camera). One browser window gives you:

- **Auto-connect** — the server scans your local network for cameras on
  startup (and every 5 minutes) by probing the VISCA-over-IP ports, and
  remembers them in `cameras.json`.
- **Multiview** — a live grid showing every camera at once (RTSP relayed to
  the browser as MJPEG via ffmpeg).
- **Unified PTZ controls** — one panel drives whichever camera you click,
  with an **ALL** switch to broadcast a command (e.g. recall preset 1) to
  every camera simultaneously.
- **Image / exposure controls** — exposure mode (auto, manual, shutter or
  iris priority, bright), iris/shutter/gain/brightness stepping, white
  balance modes, and backlight compensation.

## Requirements

- [Node.js](https://nodejs.org) 18+ (no npm packages needed)
- [ffmpeg](https://ffmpeg.org) on your PATH — only needed for the video
  previews; PTZ control works without it. On a Mac: `brew install ffmpeg`
- The computer must be on the same network/VLAN as the cameras

## Run it

**On a Mac**, just double-click **`Astra PTZ Control.command`** — it starts
the server and opens the dashboard in your browser. (First time, macOS may
block it: right-click → Open → Open, or allow it under System Settings →
Privacy & Security. Leave the Terminal window open while using the app.)

Or from a terminal on any platform:

```sh
cd ptz-control
node server.js            # then open http://localhost:8300
```

Options:

```sh
node server.js --port 9000     # different port
node server.js --no-autoscan   # don't scan the network automatically
```

The dashboard is served to any device on the network, so you can open it
from a tablet at the tech booth: `http://<this-computer's-ip>:8300`.

## Using the dashboard

- **Click a camera tile** to select it — the control panel drives that camera.
- **Hold** the D-pad / zoom / focus buttons to move; release to stop.
- **Speed slider** sets pan/tilt/zoom speed (1–24).
- **Presets 1–9**: click to recall. Tick **set mode**, then click a number to
  save the camera's current position to that slot.
- **ALL toggle**: commands go to every camera at once — handy for recalling a
  service-wide preset or sending all cameras home.
- **Keyboard**: arrow keys pan/tilt, `+`/`−` zoom, `1`–`9` recall presets,
  `H` home.
- **Scan network** re-probes the subnet; **+ Add camera** adds one by IP
  (for cameras on another subnet).

## How it talks to the cameras

| Function | Protocol | Default |
|---|---|---|
| PTZ control | VISCA over IP (Sony framing) | UDP 52381 |
| PTZ control (fallback) | VISCA over IP (raw) | UDP 1259 |
| Video preview | RTSP → MJPEG via ffmpeg | `rtsp://<ip>:554/live/av0` |

Discovery sends a VISCA *version inquiry* to every address on the local /24
subnet on both ports; anything that replies is added as a camera. If a
camera uses a nonstandard RTSP path, edit its `rtsp` field in
`cameras.json` (created next to `server.js` on first save).

## Camera setup tips (Astra P1)

- Factory default IP is `192.168.1.100` with a web UI at `http://<ip>` —
  give each camera a **unique static IP** (or DHCP reservation) so the saved
  list stays valid.
- VISCA-over-IP and RTSP are enabled out of the box; the defaults in this
  app match the camera's defaults.
- A single PoE+ cable carries power, control, and video.

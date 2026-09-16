# OrZ Control

Production-grade PTZ camera control for **Hollyland Astra** (and other
VISCA-over-IP) cameras, built for live church services and events. One
window gives you a multiview of every camera and a unified control panel —
designed so a volunteer can run it, and so it **cannot disturb the live NDI
video** feeding a YoloBox Extreme or other recorder/switcher (see
[docs/SAFETY.md](docs/SAFETY.md)).

## Highlights

- **Two modes, enforced by the server** — *Live Control* (default; safe
  control only, quiet on the network) and *Setup* (pre-service: scan,
  add/edit cameras, edit presets).
- **Bomb-proof motion** — per-camera command queues coalesce and rate-limit
  input, stop commands jump the queue and are sent redundantly, and a
  server-side motion watchdog halts any camera whose control session
  vanishes mid-move.
- **Resilient connections** — per-camera state (connected / intermittent /
  connecting / offline), automatic recovery, exponential backoff with
  jitter for offline cameras, staggered revalidation after Mac sleep/wake.
  One camera's failure never affects another.
- **First-class presets** — named per-camera presets with a separate Edit
  mode, confirmations before overwriting, and one-click/1–9-key recall.
- **Optional previews** — low-bandwidth RTSP *sub-stream* pulls, off by
  default in Live Control; never required for control, never touching NDI.
- **Diagnostics** — connection log, camera states, one-click "copy support
  info".

## Download the Mac app (easiest)

Every push to this folder builds a ready-to-use macOS app via GitHub
Actions. Grab it from the repo's **Releases** page (release
`ptz-control-latest`):

- Apple Silicon Mac (M1/M2/M3/M4, 2020+): `…-apple-silicon.dmg`
- Intel Mac: `…-intel.dmg`

Open the `.dmg`, drag **OrZ Control** to **Applications**, then
**right-click → Open → Open** on first launch (the app isn't notarized
with Apple). If macOS refuses with a "damaged" warning, run once:
`xattr -cr "/Applications/OrZ Control.app"` and open again.

The app bundles everything — no browser, Terminal, Node, or ffmpeg needed.

## Or run from source

Requires [Node.js](https://nodejs.org) 18+; the optional previews also want
[ffmpeg](https://ffmpeg.org) on your PATH (`brew install ffmpeg`). The
computer must be on the same network/VLAN as the cameras.

On a Mac, double-click **`OrZ Control.command`** — it starts the server and
opens the dashboard in your browser. Or from a terminal:

```sh
cd ptz-control
node server.js            # then open http://localhost:8300
npm test                  # run the unit + integration test suite
```

To develop on the Electron app itself: `npm install`, then `npm run app`
(window mode) or `npm run dist` (build the .dmg locally).

## Using it

See **[docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)** for the operator
walkthrough (adding cameras, checking connection, PTZ, presets, recovery,
diagnostics) and **[docs/SAFETY.md](docs/SAFETY.md)** for the
non-disruption policy toward NDI/recording paths.

Quick version: start in **Setup** to scan/add and name your cameras and
presets, then switch to **Live Control** for the service. Hold the D-pad /
zoom / focus buttons to move (release = stop), click presets to recall,
Space = stop everything, **Lock** freezes the controls.

## How it talks to the cameras

| Function | Protocol | Default |
|---|---|---|
| PTZ control | VISCA over IP (Sony framing) | UDP 52381 |
| PTZ control (fallback) | VISCA over IP (raw) | UDP 1259 |
| Optional preview | RTSP sub stream → MJPEG via ffmpeg | `rtsp://<ip>:554/live/av1` |

Control health is checked with a tiny VISCA version inquiry — never by
touching video. Discovery (Setup mode only, manual) probes the local /24
with paced unicast inquiries on both control ports. If a camera uses a
nonstandard RTSP path, set its `rtsp` field via the API or `cameras.json`.

## Camera setup tips (Astra P1)

- Factory default IP is `192.168.1.100` with a web UI at `http://<ip>` —
  give each camera a **unique static IP** (or DHCP reservation) so the saved
  list stays valid.
- VISCA-over-IP and RTSP are enabled out of the box; the defaults in this
  app match the camera's defaults.
- A single PoE+ cable carries power, control, and video.

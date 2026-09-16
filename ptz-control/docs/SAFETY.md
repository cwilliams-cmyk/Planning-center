# PTZ Control — Non-Disruption Policy

PTZ Control operates PTZ cameras (Hollyland Astra P1) on a production
Ethernet network whose PoE+ switch also carries **live NDI video** from the
cameras to a YoloBox Extreme and other recording/switching/monitoring
devices. Those video paths may be actively recording or streaming whenever
this app is in use.

**The app's rule number one: the NDI video path is externally owned, live,
and untouchable.** PTZ Control is a control-plane tool only.

## What the app does

- Sends small, rate-limited, serialized **VISCA-over-IP control commands**
  (UDP) for pan, tilt, zoom, focus, preset recall, and operator-initiated
  image/shading adjustments.
- Sends a tiny VISCA *version inquiry* as a low-frequency control-connection
  health check (every 10 s per camera in Live Control mode, 5 s in Setup;
  offline cameras back off exponentially to at most one probe per minute).
- Optionally (viewer-initiated, off by default in Live Control mode) pulls a
  **read-only copy** of a camera's RTSP **sub stream** for a small preview.
  This is a passive pull; it never configures or restarts anything on the
  camera and is never required for control.

## What the app never does

There is no code path that can:

- start, stop, restart, subscribe to, probe, or reconfigure an **NDI**
  stream (the app contains no NDI code at all);
- change stream settings, output assignment, resolution, frame rate,
  bitrate, codec, RTSP/SRT/RTMP configuration, HDMI/SDI/USB outputs;
- change a camera's IP address, subnet, gateway, DNS, or network mode;
- reboot, factory-reset, power-cycle, "reinitialize", or update firmware;
- use video availability as a health check, or make video delivery depend
  on this app in any way.

The single place camera commands are constructed is `lib/visca.js`, which
carries a **SAFETY BOUNDARY** comment block and implements only the safe
command set. A unit test (`test/visca.test.js`, "safety boundary") fails the
build if an unreviewed command builder is added.

## Failure behavior

- If PTZ Control crashes, closes, loses the network, or a control session
  drops, nothing happens to camera video: the cameras keep sending their
  existing NDI output. Reconnection re-establishes the **control session
  only** and sends no initialization or configuration commands.
- If a command cannot be validated as a known-safe control action, the
  server rejects it (`unknown action`); nothing is sent.

## Being a polite network participant

- All commands pass through a **per-camera queue** (minimum 40 ms spacing).
  Rapid joystick input is coalesced (newest movement replaces queued
  movement), so no input pattern can flood the switch.
- **Stop is prioritized**: it flushes queued movement, jumps the queue, and
  is sent twice (UDP loss protection). A server-side **motion watchdog**
  stops any camera whose movement keepalives cease (~1.3 s), so a crashed
  UI or dropped Wi-Fi can never leave a camera drifting.
- **Discovery is manual only**, allowed only in Setup mode, paced (8 hosts
  per 50 ms, unicast UDP only), and never scheduled or repeated
  automatically. Live Control mode refuses scans with:
  *"Network scan disabled in Live Control mode to protect
  production-network reliability."*
- macOS sleep stops all motion and pauses probing; wake revalidates
  cameras with **staggered** probes rather than a burst.

## Operating modes

| | Live Control (default at launch) | Setup |
|---|---|---|
| Purpose | during services/recording | pre-service configuration |
| PTZ / focus / preset recall | ✅ | ✅ |
| Image/shading (operator-initiated) | ✅ | ✅ |
| Preset save / rename | ❌ (blocked server-side) | ✅ Edit Presets |
| Add / remove / edit cameras | ❌ (blocked server-side) | ✅ |
| Network scan | ❌ (blocked server-side) | ✅ manual only |
| Health-probe interval | 10 s | 5 s |
| Previews default | off (opt-in) | on |

The app **always starts in Live Control mode** and never enters Setup mode
by itself. Mode restrictions are enforced in the server, not just hidden in
the UI.

## Command classification

1. **Safe live control** — pan/tilt drive + stop, zoom, focus, autofocus
   mode, preset recall, home, version inquiry, and (only when the operator
   has enabled it per camera) picture freeze around a preset recall, with
   redundant automatic unfreeze.
2. **Advanced image/shading** — exposure mode, iris/shutter/gain/brightness
   steps, white balance, backlight. Operator-initiated only; never applied
   automatically; applying to ALL cameras requires an explicit
   confirmation.
3. **Stream/network/output configuration** — *not implemented*. If such
   features are ever added, they must live behind the Setup mode with an
   explicit confirmation explaining that they can interrupt live video and
   recording, and this document and the `lib/visca.js` boundary must be
   updated first.

## Deliberately not implemented (needs vendor documentation)

The Astra P1's **AI tracking on/off**, **SpeedByZoom**, and **preset-call
speed** have no publicly documented VISCA command sequences. Sending
guessed bytes to a camera feeding a live recording would violate this
policy ("if a command cannot be validated as safe, it is not sent"), so
PTZ Control does not attempt them. Operate those features from the
camera's own remote or web interface. When Hollyland's VISCA extension
documentation for these commands is available, they can be added as
operator-initiated controls after hardware verification. Note the P1
ignores manual pan/tilt while AI tracking is active — the operator guide
explains this so a "stuck" camera isn't mistaken for a control failure.

## Per-camera disable and manual retry

An operator can **disable** a camera (Setup mode): the app then sends it
nothing at all — no commands, no probes, no reconnect attempts — until it
is re-enabled, while its configuration and preset labels are preserved.
**Retry control connection** (any mode) performs exactly one immediate
control-port probe for that one camera; it never touches other cameras or
any video path.

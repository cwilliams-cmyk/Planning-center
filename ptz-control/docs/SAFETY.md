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

## AI tracking control

Tracking on/off is implemented as an operator-initiated, per-camera,
control-plane command (never automatic, never broadcast to all cameras,
never re-applied after a reconnect). Because Hollyland has not published
the Astra P1's own VISCA extension list, PTZ Control offers the two
conventions used across the common OEM PTZ platforms, selectable per
camera in Setup mode:

1. **Extended VISCA** (default): `81 0A 11 54 02 FF` on / `81 0A 11 54 03
   FF` off — the sequence documented by several VISCA PTZ vendors on the
   same platform family (e.g. Zowietek, MSolutions).
2. **Preset recall 80/81**: recalling preset 80 starts tracking and 81
   stops it — plain, standard VISCA preset-recall commands.

Both are control-port packets only; a camera that does not implement a
convention ignores it or returns a VISCA error, and video/NDI is untouched
either way. **Verify tracking control on real hardware in Setup mode
before a service**, and switch the per-camera method if the default has no
effect. While tracking is active the P1 ignores manual pan/tilt, so PTZ
Control locks pan/tilt/home for that camera and rejects such commands
with an actionable message; the UI's honest state is "as last commanded"
(there is no VISCA inquiry to read tracking state back, e.g. if it was
toggled from the camera's own remote). Presenter-vs-Zone mode and zone
setup remain on the camera's web interface.

## Still not implemented (needs vendor documentation)

**SpeedByZoom** and **preset-call speed** have no publicly documented
VISCA sequences for the Astra P1 and no safe generic convention; configure
them from the camera's web interface. They can be added as
operator-initiated Setup controls once Hollyland's command list is
available and hardware-verified.

## Per-camera disable and manual retry

An operator can **disable** a camera (Setup mode): the app then sends it
nothing at all — no commands, no probes, no reconnect attempts — until it
is re-enabled, while its configuration and preset labels are preserved.
**Retry control connection** (any mode) performs exactly one immediate
control-port probe for that one camera; it never touches other cameras or
any video path.

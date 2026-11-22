# Directed Live PCM audio

The user-facing objective is a playable directed Live conversation inside Li Chat,
with streaming FFmpeg-compatible I/O. `/dev/live-audio` provides experimental,
explicit same-machine controls for an already-enabled Li microphone and a separate
return-PCM monitor, alongside synthetic sources. This frontend is not an installed
Live provider: the compatible Rechrome transport and selected browser session must
be prepared separately. It is not yet verified with a real conversation provider.

## Availability and diagnostics

The default view states that voice calling is not ready and asks for no file or
configuration. Manual capability-file import, participant IDs, synthetic sources
and PCM counters are connection diagnostics, hidden inside a closed advanced
section. Closing it cancels its route and discards the imported capability.
This is not a direct calling workflow; user-facing connection selection and
approval must be implemented before calling it ready for ordinary use.

## Trust and transport

The page checks the existing `dev` permission. A trusted local Rechrome operator
mints a 30-second, one-use, session/page-generation-bound ticket using its existing
management connection. The browser imports that JSON file locally: it is never
uploaded, persisted, placed in a URL or rendered as text. No management key goes to
the page and there is no unauthenticated mint route.

The browser validates the exact client Origin, expiry, participants, format, frame
size, byte window and `ws://127.0.0.1:<port>/stream` endpoint. The gateway independently
authenticates the capability and actual WebSocket Origin. The current transport is
same-machine only. Phone/remote operation needs a separately authorized trusted WSS
gateway; the cloud app cannot connect to a user's loopback address.

Chrome's local-network permission is required. The permission prompt precedes the
WebSocket opening: connection waits only for the ticket's remaining lifetime, then
the protocol's two-second hello/ready deadline starts after open. No CSP,
mixed-content or local-network protections are disabled. Denied/unsupported access
fails closed and requires a new explicit attempt.

## PCM and control

PCM is signed 16-bit little-endian, 16 or 48 kHz, mono or stereo, exactly 20 ms per
binary message. There are no WAV headers or metadata inside audio bytes. JSON hello,
ready, byte credits, output descriptors, ordered output ACKs and terminal controls
are separate. Input and output have independent eight-frame credit windows.

Output can arrive before input EOF. End input half-closes only the feeding side;
output continues. Stop/cancel and protocol/network failure cancel immediately,
without waiting for a consumer. Normal `duration-limit` and `renderer-ended` endings
instead drain already received frames for at most two seconds; cancel can interrupt
that drain. Queues and pending input are bounded. There is no automatic reconnect.

## Routing and explicit endpoints

Sources and targets are explicit. Internal bus aliases cannot collide with ticket
participants. Each destination mixes separately; mix-minus follows the original
participant even when a source is forwarded under an alias. Direct self-routes are
rejected. This does not prove the absence of arbitrary feedback cycles across
external services and is not acoustic echo cancellation.

Basic per-frame linear rate/channel conversion precedes mixing. It is not a
high-quality band-limited resampler: upsampled boundary tails repeat and downsampling
has no dedicated anti-alias filter. Gains are bounded and mixed samples saturate
before PCM encoding. Removing a source/gain change retracts an unsent stale mix frame
without closing other sources or the connection; already sent audio is not retractable.

The panel shows the ticket's exact source/target IDs and separate source switches,
gains, Start, End input, Stop and frame/clipping counters. Its two optional synthetic
sources use 16 kHz mono and 48 kHz stereo. Selecting the Li microphone switches the
synthetic sources off (they can be explicitly re-enabled). The microphone must
already be enabled in Li on the same page: this feature never calls getUserMedia,
starts the mic session, changes its wake policy or requests a device. The read-only
PCM observer excludes held, cue, shadow and voiceprint-enrolment capture. Off/hold
clear subscribers immediately; variable capture chunks become 20 ms frames with a
160 ms freshness/queue bound, including incomplete frames. Removing the route clears
its buffer. There is no recording or upload outside the selected PCM route.

Monitor is a separate, default-off user gesture. Returned PCM alone reaches the
shared Web Audio context; speechSynthesis is not scraped or redirected. The monitor
uses the existing `play` audio priority, yields to Li read-aloud, respects its mute,
and registers playback with page-audio so the existing AEC-off capture hold and echo
tail still apply. Hidden pages stop output; context/resume failure closes the route
instead of silently retaining audio ownership. Re-enabling requires a user action;
no queued audio is replayed after mute or priority loss. Start/Stop/navigation manage
only this route, never other capture or audio sessions. A same-page hot-loaded mic
from an older build must be reloaded before it can publish this new PCM observer.

Configuration keys `voice.liveToneHz`, `voice.liveTonePeakPct`, `voice.liveGainPct`,
`voice.liveMaxGainPct` and `voice.liveUiRefreshMs` supply editable defaults.

## Local setup and remaining dependency

Rechrome #110 and #112 are currently unmerged and unreleased; the stock installed
CLI/daemon is **not verified** to support this protocol. Do not auto-install,
restart a daemon, or present this frontend as live because synthetic tests passed.
After an approved compatible update and bridge installation in the selected stable
session, the trusted local operator uses:

```sh
rech audio install <stable-session>
rech audio stream ticket --source <li-source> --destination <stable-session> \
  --client-origin https://<exact-Li-origin> --ticket-file <private-ticket.json>
```

Import the ticket locally, select the intended sources, press Start, and grant the
browser's standard local-network permission if requested. The one-use ticket lasts
30 seconds; mint a new one after expiry or a failed attempt. For a real audition,
the user must first enable Li's microphone, explicitly select it here and opt into
Monitor. Tests below use synthetic capture and muted graphs, never a real microphone,
physical playback or a paid provider. Phone/remote transport remains unsupported.

## Verification

- `bun test unit/live-audio.test.ts unit/live-audio-content.test.ts unit/live-audio-endpoints.test.ts`: deterministic
  mix-minus/provenance, formats, clipping, credits, source cancellation, half-close,
  slow consumers, graceful tails, ticket bounds and 16-locale context.
- `bun scripts/qa/qa-live-audio.ts`: real panel and synthetic local transport,
  including actual PCM frequencies after source cancellation under slow credits,
  synthetic already-on mic frames, explicit muted monitor and read-aloud mute.
- Optional cross-project check: add `--gateway-module <Rechrome audio-stream-server.ts>`.
  Its renderer remains synthetic; this does not install/restart the normal daemon.
- Optional hosted-origin check: add `--chrome --origin <hosted HTTPS origin>`.
  Only that isolated test context grants local-network permission. Normal user
  profile permissions remain untouched. Tests use the shared audio-free layer.

The Rechrome transport and FFmpeg adapter are developed in
[Rechrome #112](https://github.com/snomiao/rechrome/pull/112), stacked on its earlier
media bridge. CLI stdin/stdout remain raw PCM; diagnostics go to stderr. A ticket
file is control authorization, not audio file feed/drain.

# Directed Live PCM audio

The user-facing objective is a playable directed Live conversation inside Li Chat,
with streaming FFmpeg-compatible I/O. The first implementation milestone is an
explicit developer routing console at `/dev/live-audio`; it is **synthetic and
counter-only**, not yet that complete conversation experience.

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

## Routing and current milestone

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

The current console generates two optional synthetic sources (16 kHz mono and
48 kHz stereo). It displays participant IDs, independent source switches/gains,
Start, End input, Stop and frame/clipping counters. Returned PCM is a logical bus,
not a physical output. Its own participant is excluded from that participant's
outgoing mix. Configuration keys `voice.liveToneHz`, `voice.liveTonePeakPct`,
`voice.liveGainPct`, `voice.liveMaxGainPct` and `voice.liveUiRefreshMs` supply the
editable defaults. Import alone starts nothing; navigation cancels the route.

Default device speechSynthesis is not a Web Audio/PCM source. The existing voice,
physical audio-owner priority, mute and AEC flows are unchanged at this milestone.
The next slice is explicit user-selected endpoints: a read-only tap on an already
user-enabled Li microphone and an explicitly enabled monitor sink respecting those
existing policies. No automatic device opening or model call is part of testing.

## Verification

- `bun test unit/live-audio.test.ts unit/live-audio-content.test.ts`: deterministic
  mix-minus/provenance, formats, clipping, credits, source cancellation, half-close,
  slow consumers, graceful tails, ticket bounds and 16-locale context.
- `bun scripts/qa/qa-live-audio.ts`: real panel and synthetic local transport,
  including actual PCM frequencies after source cancellation under slow credits.
- Optional cross-project check: add `--gateway-module <Rechrome audio-stream-server.ts>`.
  Its renderer remains synthetic; this does not install/restart the normal daemon.
- Optional hosted-origin check: add `--chrome --origin <hosted HTTPS origin>`.
  Only that isolated test context grants local-network permission. Normal user
  profile permissions remain untouched. Tests use the shared audio-free layer.

The Rechrome transport and FFmpeg adapter are developed in
[Rechrome #112](https://github.com/snomiao/rechrome/pull/112), stacked on its earlier
media bridge. CLI stdin/stdout remain raw PCM; diagnostics go to stderr. A ticket
file is control authorization, not audio file feed/drain.

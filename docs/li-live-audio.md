# Directed Live PCM audio

The user-facing objective is a playable directed Live conversation inside Li Chat,
with streaming FFmpeg-compatible I/O. `/dev/live-audio` provides experimental,
explicit same-machine controls for an already-enabled Li microphone and a separate
return-PCM monitor, alongside synthetic sources. This frontend is not an installed
Live provider: the compatible Rechrome transport and selected browser session must
be prepared separately. It is not yet verified with a real conversation provider.

## Ordinary connection and diagnostics

The ordinary flow is Connect, choose the chat and allow on the local confirmation
page, then Start talking. It never asks for files, JSON, session IDs or terminal
codes. Discovery and consent use the local pairing v2 contract; Li requests omit
credentials, never send its cookies or a management key, and pin every response
endpoint to the same loopback origin and exact operation path. Native local-network
permission is preserved. Discovery allows up to 120 seconds for a human permission
response; subsequent RPCs use five-second deadlines. Cancel remains immediate.

Creating a request grants no audio access. After explicit local approval, the
one-use ticket opens the selected chat's PCM transport, including receiving its
output. Start talking separately enables the already-on Li mic source and physical
return monitor. It is not a promise that all target audio capture waits for that
button. Disconnect, Cancel and navigation revoke this request and close its route.

The local confirmation link is a specific application action: only the validated
loopback approval endpoint is marked as already-confirmed for the generic outbound
link guard. It still opens without an opener/referrer, and still requires the local
authenticated consent page and native network permission. Arbitrary hosts, ports,
paths, credentials, fragments or additional query parameters cannot use that path.

Manual capability-file import, participant IDs, synthetic sources and PCM counters
remain inside closed advanced diagnostics. Closing diagnostics cancels a manual
route, but inspecting and closing diagnostics never ends an ordinary call. Service
unavailability, denial and expiry are shown in ordinary language with retry.

## Trust and transport

The page checks the existing `dev` permission. The trusted local Rechrome companion authenticates the operator and displays the
requesting website and selected chat. Only that explicit local consent mints a
30-second, one-use, session/page-generation-bound capability. The browser receives
it through the origin-bound request status, never a file in the ordinary flow.
No capability is persisted, placed in a URL or rendered as text. No management key
goes to the page and there is no unauthenticated mint route. Optional manual-file
import exists only inside advanced diagnostics and never uploads the file.

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

The advanced panel shows the ticket's exact source/target IDs and separate source switches,
gains, Start, End input, Stop and frame/clipping counters. Its two optional synthetic
sources use 16 kHz mono and 48 kHz stereo. Selecting the Li microphone switches the
synthetic sources off (they can be explicitly re-enabled). The microphone must
already be enabled in Li on the same page: this feature never calls getUserMedia,
starts the mic session, changes its wake policy or requests a device. The read-only
PCM observer excludes held, cue, shadow and voiceprint-enrolment capture. Off/hold
clear subscribers immediately; variable capture chunks become 20 ms frames with a
160 ms freshness/queue bound, including incomplete frames. Removing the route clears
its buffer. There is no recording or upload outside the selected PCM route.

Monitor is a separate, default-off user gesture (Start talking in the ordinary flow). Returned PCM alone reaches the
shared Web Audio context; speechSynthesis is not scraped or redirected. The monitor
uses the existing `play` audio priority, yields to Li read-aloud, respects its mute,
and registers playback with page-audio so the existing AEC-off capture hold and echo
tail still apply. Exact digital silence skips playback and ownership entirely, so
it cannot hold the mic or interrupt another player; even one-LSB nonzero audio is
retained. Hidden pages stop output; context/resume failure closes the route
instead of silently retaining audio ownership. Re-enabling requires a user action;
no queued audio is replayed after mute or priority loss. Start/Stop/navigation manage
only this route, never other capture or audio sessions. A same-page hot-loaded mic
from an older build must be reloaded before it can publish this new PCM observer.

Configuration keys `voice.liveToneHz`, `voice.liveTonePeakPct`, `voice.liveGainPct`,
`voice.liveMaxGainPct` and `voice.liveUiRefreshMs` supply editable defaults.

## Local setup and remaining dependency

The released core and the interactive pairing component are separate requirements.
The core release alone does not implement the interactive confirmation flow. The
installed CLI/daemon must be verified to include pairing v2 and its trusted local
companion setup before the ordinary Connect flow is called ready. Do not auto-install,
restart a daemon, or present this frontend as live because synthetic tests passed.
After an approved compatible update and bridge installation in the selected stable
session, the trusted local operator uses:

```sh
rech audio install <stable-session>
rech audio stream ticket --source <li-source> --destination <stable-session> \
  --client-origin https://<exact-Li-origin> --ticket-file <private-ticket.json>
```

The command above is for advanced transport diagnostics only. Ordinary users use
Connect and the local chat confirmation page, with companion initialization handled
by the trusted installation path. For diagnostics, import the ticket locally, select
the intended sources, press Start, and grant the
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

### Interactive consent verification

`bun scripts/qa/qa-voice-connection.ts --pairing-module <audio-pairing.ts> --gateway-module <audio-stream-server.ts>`
runs the real panel against compatible local pairing/gateway modules. Optional
`--chrome --origin <hosted HTTPS origin>` proves HTTP permission/CORS and the popup
with the app's outbound-link guard present. The isolated context pregrants native
LNA; a separate deterministic delayed-permission test covers waiting beyond five
seconds and immediate cancellation. The browser smoke does not prove a human
actually waited at a native prompt.

The local operator and selected chat are synthetic fixtures; no real provider,
microphone or audible output is used. The checks cover HttpOnly operator consent,
actual chat-title selection, pending cancel/retry, silence before Li Start talking,
explicit synthetic mic/monitor, diagnostics inspection and server-side revocation.
Disconnect affects this audio link only; it preserves the existing Li mic session
and does not claim to end a separate model call in the selected browser chat.
`unit/voice-pair.test.ts` covers pinned endpoints, response bounds, stale or invalid
identity, denied/expired consent, delayed discovery and cancellation.

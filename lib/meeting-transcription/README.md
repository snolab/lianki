# Meeting transcription consumer

This headless consumer connects the Otoji meeting-transcript SDK to Lianki's
account routes. It does not capture, play, archive, or upload audio. The recorder
continues archiving independently when live transcription stops or falls behind.

`createBrowserMeetingTranscription` is the concrete browser entry point: it lazily
loads `sdk.ts` (the pinned `vendor/otoji/packages/meeting-transcript/src/index`
exports) and the real recorder module. It creates the recorder singleton only when
live subscription starts after account authorization, and refuses a recorder for
another meeting. Its injectable recorder getter/SDK keep tests free of capture.
The host still supplies a provider chosen explicitly for this meeting and its
configuration-backed limits; there is no automatic provider selection.

The host supplies the real SDK exports, an explicitly selected provider, limits
read from its configuration, UI callbacks, and `meetingRecorder().onPcm`:

```ts
const transcribe = createMeetingLocalStt({
  route: "rtc:lianki", // Chosen explicitly for this meeting, never inferred from mic consent.
  maxSamples: providerWindowSamples,
});
const transcription = createMeetingTranscription({
  meetingId,
  sdk,
  transcribe,
  limits,
  decodeChunk: createMeetingChunkDecoder(limits),
  subscribePcm: (listener) => meetingRecorder().onPcm(listener),
  onDraft,
  onStatus,
});

// A trusted UI action calls this. Nothing starts on construction or reload.
await transcription.startLive({ userInitiated: true });
// Once capture ends: drain accepted PCM and persist the SDK's stable lines.
await transcription.finishLive();
// A separate explicit action rereads the archived audio-only tracks.
await transcription.runFinal({ userInitiated: true }, signal);
```

`stop()` immediately detaches live PCM, clears drafts and queued audio, aborts
pending fetches, and closes the SDK and provider clients. `close()` also prevents
another run. Neither method stops the archival recorder. A write already accepted
by the server cannot be rolled back by browser cancellation.

The synchronous `push({track,startSample,samples})` method is available to another
capture integration. It copies admitted frames, bounds queued/in-flight samples
per track, and returns false on rejection. The `backpressure` status includes the
dropped sample range. Later frames retain their original absolute offsets; no
audio is inserted into a gap. Drafts are only delivered to `onDraft` in memory;
only SDK stable callbacks create `source: live` writes.

Final transcription fetches `{chunks:[...]}` for `me` and `others`, then one
independently decodable WebM/Opus piece at a time from the account's own routes.
It validates ordering, response timing headers, size and decoded duration.
The decoder uses an unconnected `OfflineAudioContext` and downsamples mono/stereo
PCM to 16 kHz. Encoder padding can be trimmed within the configured tolerance;
a shorter piece leaves an actual gap rather than zero-filled synthetic audio.
Native `decodeAudioData` allocates decoded audio before this code can inspect its
duration or channel count. Encoded-size checks do not cap that native allocation.
This path is for independently recorded account chunks from the trusted recorder;
it is not a hardened hostile-media decoder. No native decode memory bound is claimed.
Each awaited SDK `onWindow` callback sends one atomic `source: final` replacement,
including an empty batch for silence. Failed or aborted windows make no replacement.
An SDK without completed-window callbacks fails rather than reporting success.

The real provider adapter uses the existing `createLocalStt` protocol and
`publicOpen("rtc:lianki")`. It maintains at most two clients, one per track, and
rejects concurrent utterances on the same client. It does not enable automatic
background reopening. A legacy socket requires both an explicit URL and the
host's approved socket factory. There is no default provider, public WSS/session
fallback, Workers AI fallback, endpoint discovery, or local model download.
The server's `LocalFinal` has no word timestamps; its text honestly spans the
supplied window, not its decode-time `ms` field. Real-service throughput and browser
WebM decoding have not been exercised with recordings by these unit tests.

The host must map status codes to its translated UI. Raw provider exceptions,
transcripts, route credentials and decoded audio never go into status messages.
Live and final runs are mutually exclusive on one consumer. A host should keep one
consumer per meeting, and call `close()` on navigation or revocation of its choice.

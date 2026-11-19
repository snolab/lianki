# Voiceprint as a service

**Status: design, nothing built.** The owner asked on 2026-11-19 (~14:40 JST)
for the voiceprint (speaker identification) to become a proper service, not a
script that only runs on his Mac. It must not depend on Tailscale or similar
network infrastructure. Earlier the same day he said speaker clusters should
eventually live in each person's own account (test phase: on his Mac).

Today's system is in [local-stt.md](local-stt.md) ("Voiceprint", "Household
voices", "Speaker clusters") and [voice-mode.md](voice-mode.md) ("Speaker
clusters"). This doc covers what changes and what stays.

## In one screen

- **Recommendation: hybrid, with two trust levels.**
  1. **In the browser (c):** CAM++ runs on the phone through onnxruntime-web.
     Audio never leaves the device; only embeddings go to the account. This
     gives avatars, clusters and the "only my voice" filter. The tag it makes
     is `device` trust: it is never the green check and never an approval.
  2. **Cloudflare Containers (b):** this is the signed path. The audio of one
     utterance goes to a container that holds no keys and keeps nothing. The
     container returns the text and the embedding, and the **lianki.com
     Worker** compares that embedding with the sealed print and signs the
     proof. This gives `service` trust: the green check, and later voice
     approvals.
  3. **His Mac over WebRTC (d)** stays as one more signer (`mac` trust, the
     current proofs). It is reached through lianki.com signalling, not the
     tailnet.
- **Workers AI (a) is out**: the catalogue has no speaker-embedding model
  (checked 2026-11-19, below).
- **Prints and clusters move into the account**, in D1, sealed per account.
  Other voices belong to the account that heard them ("people I hear"). They
  are never matched across accounts.
- **Nothing breaks on the way.** The hub accepts a key ring (`mac`, `service`)
  instead of one public key. The Mac keeps signing as it does now until the
  service has proven itself on his phone.

## What the service does

| op                  | input                                      | output                                                     | who calls                                         |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| **enrol**           | 10–20 read sentences (audio or embeddings) | a print: embeddings, centroid, self scores                 | the Voiceprint panel, after consent and a passkey |
| **verify**          | one utterance                              | `me` / `other` / `unknown`, score, reasons, a signed proof | the mic path (`mic.ts`, `local-stt.ts`)           |
| **cluster**         | an `other` utterance's embedding           | a stable label (`A`, `B`…, `household:<name>`)             | verify, as a side output                          |
| **household**       | clips the owner picks of one family voice  | a household print (named, his account)                     | the panel ("This is a household voice")           |
| **export / delete** | a passkey ticket                           | JSON of features / rows gone                               | the panel, /my                                    |

The rules stay as they are now: the noise gate (`short`, `noise`), the bands
(0.28 / 0.18 under 3 s, 0.30 / 0.20 from 3 s), the household margin
(`ME_MARGIN` −0.25, `OTHER_MARGIN` −0.30), windows and the split at a speaker
change. They move from Python constants into config keys (below), so the Mac,
the container and the browser use the same numbers.

**Callers.**

- **The browser mic path.** It calls verify for each final. It uses the
  in-browser embedding first (fast, private), and the service when a signed
  tag is needed (see "When the audio goes up").
- **The hub** (`lianki-push`, `lib/speaker-proof.ts`). It never calls the
  service; it only checks proofs. It adds one thing: a key ring.
- **The Voiceprint panel** for enrol, household, export and delete.

## Hosting options, compared

|                        | (a) Workers AI | (b) Containers            | (c) In browser           | (d) WebRTC node        |
| ---------------------- | -------------- | ------------------------- | ------------------------ | ---------------------- |
| speaker model          | **none**       | CAM++ (ours)              | CAM++ int8               | CAM++ (ours)           |
| audio leaves device    | —              | yes, transient            | **no**                   | yes, to his node       |
| can sign "me"          | —              | **yes** (Worker key)      | **no** (see Trust)       | yes (node key)         |
| works with his Mac off | —              | **yes**                   | **yes**                  | no, unless other nodes |
| needs Tailscale        | —              | no                        | no                       | no (lianki.com signal) |
| cold start             | —              | ~2–3 s, tail to tens of s | model load once per page | ICE ~1–6 s             |
| cost                   | —              | ~$1–5 / month (below)     | ~0                       | ~0 + TURN              |

### (a) Cloudflare Workers AI: not possible today

The model catalogue
([developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models/),
read 2026-11-19) has 76 models. Its audio models are ASR (`whisper`,
`whisper-large-v3-turbo`, `whisper-tiny-en`, `nova-3`, `flux`), TTS (`aura-1`,
`aura-2-en`, `aura-2-es`, `melotts`) and `smart-turn-v2`. There is **no
speaker embedding, verification or diarization model**: no pyannote, ECAPA,
CAM++, WeSpeaker or TitaNet. `embeddinggemma-2` takes audio, but it is a general
multimodal embedding. It is not trained to separate speakers, and its scores
would need a calibration we do not have. Re-check this once a quarter;
Workers AI does not take custom models we upload.

### (b) Cloudflare Containers running CAM++

The same `voiceprint.py` + sherpa-onnx (and optionally SenseVoice, so the
proof can cover the text: see Trust) in a container image, behind a Durable
Object, called by the lianki.com Worker.

- **Size.** CAM++ zh-en is 28 MB (fp32, 192-dim), with about 150 MB more RAM
  at peak (measured on the Mac). With SenseVoice-Small int8 (~230 MB) the
  image needs about 1 GiB of RAM, so `basic` (¼ vCPU, 1 GiB) is enough for
  embeddings only and `standard-1` (½ vCPU, 4 GiB) is enough for both.
- **Speed.** On the Mac, CAM++ takes ~6 ms per audio second at normal priority
  (~18 ms in the background). A shared x86 vCPU is perhaps 2–4× slower
  (**estimate**, measured in M2): ~50–150 ms for a 5 s utterance on ¼ vCPU.
- **Cold start.** Cloudflare documents 1–3 s
  ([FAQ](https://developers.cloudflare.com/containers/faq/)). An independent
  2026 benchmark saw a median of ~2 s with a tail up to ~50 s
  ([alchemy.run](https://alchemy.run/blog/2026-07-01-microvm-cold-starts/)).
  So: keep one instance warm while any mic is on (the page's `hello` wakes
  it), sleep after `voiceprint.service.idleS` (300 s). A final that arrives
  during a cold start is `unknown` (`cold`), never blocked.
- **Stateless.** The container gets audio and returns `{embedding, text?,
  speechS, snrDb}`. It never sees a print, a key, an account id or a file
  system worth keeping. The Worker does the deciding and signing.

### (c) In-browser embeddings (onnxruntime-web / WASM)

CAM++ in the page: Silero VAD already runs there (`mic.ts`), so the
utterance's 16 kHz samples are in hand.

- **Model.** CAM++ int8 ≈ 7–8 MB (a quarter of the 28 MB fp32; to be
  re-checked against the 0.30 / 0.20 bands, since int8 shifts scores). The
  fbank features are computed in JS or WASM. sherpa-onnx ships a WASM build
  with speaker ID and diarization demos
  ([k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)), so either
  that build or onnxruntime-web plus our own fbank.
- **Runtime.** onnxruntime-web's SIMD WASM is roughly 10 MB uncompressed,
  ~3 MB over the wire (**estimate**, measured in M4). It is fetched once,
  cached by the service worker ([cold-start.md](cold-start.md)), and loaded
  only after the mic is turned on, never on page load.
- **Latency on a phone.** WASM on a recent iPhone is perhaps 3–8× slower than
  native on the Mac (**estimate**): ~20–50 ms per audio second, so 60–250 ms
  for a 3–5 s utterance. It runs in a worker beside the STT round trip. The
  0.2 s feedback rule holds because the line shows first
  and the avatar follows.
- **Battery / memory.** One inference per final, not per frame: ~30 MB more
  page memory with the session loaded. Older Android phones may be too slow;
  there the page falls back to (b) or to no tag.
- **What goes up.** Only the 192 floats (768 bytes) per utterance, and only
  when clusters are kept in the account. Never audio.

### (d) otoji-style WebRTC to a compute node

Lianki already has this for STT: the page negotiates through
`wss://lianki.com/api/version/stt/signal` (the `SttRegistry` Durable Object in
`lianki-push`), and `stt-peer` (Go, pion) on the node dials **out**. There is
no inbound port and no Tailscale ([local-stt.md](local-stt.md), "Lianki's
speech servers for everyone", "His own Mac over WebRTC"). otoji's
`otoji.org/signal/{room}` Worker is the same pattern (DO relays SDP/ICE,
Cloudflare Realtime TURN for symmetric NAT); read for reference only.

- Good for **his own Mac**: free compute, his own print, his own key. This is
  the current proof path with a different transport.
- Not a service by itself: it needs a node online, and another user's node
  would have to be trusted with their audio and hold a signing key. Keep it
  as a signer for the node's owner only (`stt_worker.owner_user_id`).

### The recommendation and why

**(c) for everything that needs no trust, (b) for the signed tag, (d) kept
for his Mac.**

- Privacy: most utterances, and every utterance from someone who is not
  enrolled, never send audio anywhere for the voiceprint.
- Trust: a browser cannot prove what it heard (next section). Only a party
  that saw the audio can sign "this was his voice saying these words", so
  the signed tag needs (b) or (d).
- Independence: (b) and (c) need neither his Mac nor Tailscale. (d) needs
  neither Tailscale nor a tunnel.
- Cost: (c) is free, and (b) runs only when a signed tag is asked for.

## Trust: who may sign "me"

Today the Mac signs `{v:1, uid, thread, at, text, decision, score, model,
device, …}` with `speaker-attest.key`, and the hub checks it against
`STT_SPEAKER_PUB`. That works because the Mac **heard the audio and decoded
the text itself**.

**The browser cannot self-sign.** Any key in the page can be read by page
code (eval, an extension, a script). And even a perfect browser model can
be fed a recording, or can skip the model and send the stored centroid. A
server that receives only an embedding cannot tell either case from real
speech. So:

- A browser tag is `trust: "device"`. It may pick an avatar, a cluster
  letter and the local filter. **It never shows the check (`VoiceMark`) and
  never counts for an approval.** The hub stores it as advisory
  (`speaker.advisory`), separate from `speaker`.

**The service signs, without the Mac's key.**

```
page ─ WSS lianki.com/api/voiceprint/verify {ticket, uid, thread, pcm} ─▶ Worker
Worker ─ DO binding ─▶ container: {embedding, text, speechS, snrDb}       (no key, no print)
Worker: open the sealed print (D1), decide (same bands), sign with STT_SPEAKER_KEY
     ◀─ final {text, speaker, speakerProof: kid "service"} ─
```

- `STT_SPEAKER_KEY`: an Ed25519 private key, a **Worker secret on `lianki`**.
  Its public half joins the hub's ring as `kid: "service"`. The container
  never holds it.
- **Text binding.** The proof signs the text the **container decoded** from
  the same audio, as the Mac does. If the page's text came from somewhere
  else (cloud Whisper fallback, a cleanup), the proof carries
  `text: null, audioSha256` and the hub keeps the speaker only as advisory.
  Approvals require a signed text.
- **The ticket.** Each verify socket needs a short ticket for this account
  (the session, like `/api/stt/session`), so a page cannot verify against
  another account's print. The print is chosen by the session, never by the
  request.
- **Key ring in the hub.** `STT_SPEAKER_PUBS` = `{"mac": "<b64>", "service":
  "<b64>"}`. A proof without `kid` is `mac` (every proof signed today). The
  stored tag records `kid`, so the UI and approvals can tell who signed.
- **Replay of a recording** (someone plays his voice to the mic) is the same
  weakness for every signer, the Mac included. Liveness (a spoken
  challenge phrase for approvals) is an open question below. It is not
  solved by moving hosts.

## When the audio goes up

The user picks it on the consent screen (config default in brackets):

| mode                             | what goes to (b)                  | what you get                             |
| -------------------------------- | --------------------------------- | ---------------------------------------- |
| **device only**                  | nothing                           | avatars, clusters, filter; no check mark |
| **signed when needed** [default] | lines sent to an agent, approvals | the check on those lines                 |
| **signed always**                | every final                       | the check on every line                  |

His account: "signed always" through his Mac (d) when it is reachable,
otherwise the service (b). The race order is config
(`voiceprint.signers`, below).

## Biometric data

### What is stored

Embeddings only, never audio, in the account that owns them:

| table                       | rows                           | sealed payload                                      |
| --------------------------- | ------------------------------ | --------------------------------------------------- |
| `voiceprint` (exists, 0071) | his print per device and model | centroid, embeddings, self scores                   |
| `voice_cluster` (new)       | voices this account heard      | centroid, n, first/last heard; label; optional name |

Size: a print of 20 × 192 float32 is ~16 KB sealed, and a cluster ~1 KB.
Nothing goes to R2 (the optional enrolment recordings stay in My Files, as
now).

### Encryption: a key per account

Today: one HKDF key from `AUTH_SECRET` (salt `lianki/voiceprint`), with the
user id in the AAD. Proposed v2: put the account into the key as well, so a
bug that drops the AAD still cannot open another account's rows:

```
key(uid) = HKDF-SHA256(AUTH_SECRET, salt "lianki/voiceprint", info "lianki/voiceprint/v2/" + uid)
AAD      = "voiceprint" | uid | kind (print | cluster) | device | model | row id
```

v1 rows stay readable and are re-sealed as v2 on their next write. Rotating
`AUTH_SECRET` still leaves them unreadable (as with recordings). A
dedicated `VOICEPRINT_KEK` would avoid that; this is an open question below.

### Other people's voices: "people I hear"

- **A cluster belongs to the account that heard it.** His wife's voice on his
  phone is a row in **his** account. It is never her print, even if she has an
  account. Lianki never compares one account's clusters or prints with
  another's: no "this is also user X", no global voice index. Every statement
  carries the caller's uid, like recordings.
- **A household print** is a cluster he promoted and named ("household:wife"
  stays a label the user types, never taken from anyone's account).
- **Unnamed clusters are forgotten** after `voiceprint.clusterForgetDays`
  (30) without being heard. Today they live in memory and reset at midnight.
  Named ones stay until deleted.
- **Her own account** may enrol her own print. That is her row, under her own
  consent, and is unrelated to his cluster of her.

### Consent, retention, delete, export

- **Consent screen** before the first enrolment, and again before clusters are
  kept in the account. It says: what an embedding is (numbers, not a
  recording); where it is kept; the mode ("When the audio goes up"); that
  other voices nearby become unnamed clusters in **your** account; retention;
  delete and export. Buttons: "I agree, start" / "Not now". The tap and its
  version are stored (`voiceprint_consent`: uid, version, at). No consent,
  no print and no clusters; the mic works as before.
- **Retention.** Own print: until deleted, or `voiceprint.printUnusedDays`
  (1095) without a verify, whichever comes first, with a mail 30 days before.
  Clusters: as above. Deleting the account deletes all of it.
- **Delete.** As now (one passkey ticket, the Mac and the account both), plus
  "Delete all voices I hear". Deleting a print never deletes recordings
  silently; the separate question stays.
- **Export.** `GET /api/my/voiceprint?export=1` (session plus passkey
  ticket): one JSON file with prints and clusters, decrypted, model name and
  dimension included.

### Legal note (factual, not advice)

- **Japan, APPI.** Voiceprint data converted so that it can identify a person
  is an "individual identification code" (個人識別符号), so it is personal
  information on its own. It is not in the special-care category
  (要配慮個人情報). The purpose of use must be stated, and third-party
  provision needs consent.
- **EU/UK, GDPR Art. 9.** Biometric data processed "for the purpose of
  uniquely identifying a natural person" is special-category data. The
  usual basis is explicit consent (Art. 9(2)(a)). Clusters of bystanders are
  the hard case: the user's own household use may be exempt (Art. 2(2)(c)),
  but Lianki as the service is not.
- **US, Illinois BIPA** (if US users join): written consent before
  collection, and a public retention schedule with destruction within 3
  years of the last interaction. That is where the 1095-day default comes from.
- **So:** an explicit consent screen; a published retention policy; clusters
  only distinguish voices and never identify them unless the user names
  them; no cross-account matching. Have counsel review before (b) or (c)
  opens to accounts other than his.

## Migration without breaking today

His current flow (phone, then tailnet or `stt.lianki.com` or WebRTC to the
Mac, the Mac's proof, then the hub) keeps working at every step.

1. **Key ring.** The hub reads `STT_SPEAKER_PUBS`, falling back to
   `STT_SPEAKER_PUB` as `mac`. No change to the Mac.
2. **Bands in config.** The Mac reads the bands and margins from
   `GET /api/my/voiceprint` (already called), with its constants as defaults.
3. **Clusters to the account (test phase on the Mac).** The Mac's `Verifier`
   keeps clusters in memory as now, and also writes them, sealed, through
   `PUT /api/my/voice-clusters`, under the flag. Labels survive midnight and
   restarts.
4. **The service (b) beside the Mac.** Added to the route race after his Mac.
   He compares the decisions of both on the same finals (devLog
   `speaker-ab`) before anything relies on `service`.
5. **The browser (c)** behind its flag, for avatars first.
6. **Tailscale optional.** The owner's default route list becomes `rtc:mac,
   service`. The tailnet URL remains only if he keeps it in his list.

**Flags** (positive names, ON = feature active; owner audience, on for him
when shipped; off for others until consent and legal review):

| flag                          | on means                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| `voiceprint.service`          | the cloud verifier (b) is offered and can sign                             |
| `voiceprint.browser-embed`    | the page computes embeddings itself (c)                                    |
| `voiceprint.account-clusters` | clusters are kept in the account, not just memory                          |
| `voiceprint.public`           | accounts without `dev` may enrol (default off: biometric, like recordings) |

**Config keys** (`lib/config.ts`, the code holds only defaults):

| key                                     | default                   | note                                |
| --------------------------------------- | ------------------------- | ----------------------------------- |
| `voiceprint.extractor`                  | `mac`                     | add `browser`, `service`            |
| `voiceprint.signers`                    | `["mac","service"]`       | race order for a signed tag         |
| `voiceprint.uploadMode`                 | `when-needed`             | `device` / `when-needed` / `always` |
| `voiceprint.bands`                      | today's table             | me/other per length, SNR gate       |
| `voiceprint.householdMargins`           | `{me:-0.25, other:-0.30}` |                                     |
| `voiceprint.clusterSame` / `clusterMax` | 0.30 / 8                  | as `CLUSTER_*` now                  |
| `voiceprint.clusterForgetDays`          | 30                        | unnamed clusters                    |
| `voiceprint.printUnusedDays`            | 1095                      | own print                           |
| `voiceprint.service.idleS`              | 300                       | container sleep                     |
| `voiceprint.browserModelUrl`            | R2 path of CAM++ int8     | versioned                           |

Secrets: `STT_SPEAKER_KEY` (lianki, new), `STT_SPEAKER_PUBS` (lianki-push,
replaces `STT_SPEAKER_PUB`). Both are set only after his tap card.

## Cost

List prices read 2026-11-19
([Containers pricing](https://developers.cloudflare.com/containers/pricing/)):
vCPU $0.000020 / s (375 vCPU-min free per month), memory $0.0000025 /
GiB-s (25 GiB-h free), disk $0.00000007 / GB-s (200 GB-h free), billed per
10 ms while running, sleeping costs nothing. Workers Paid $5 / month (already
paid).

| item                                     | assumption                                           | per month                   |
| ---------------------------------------- | ---------------------------------------------------- | --------------------------- |
| (b) `basic` 1 GiB awake                  | mic on 4 h/day → 120 GiB-h, minus 25 free            | 95 × $0.009 ≈ **$0.86**     |
| (b) `standard-1` 4 GiB (with SenseVoice) | the same hours, 480 GiB-h − 25                       | ≈ **$4.10**                 |
| (b) CPU                                  | ~0.1 vCPU-s per 5 s utterance, 2,000 / day           | 100 vCPU-min, **free tier** |
| (c) browser                              | model ~8 MB + runtime ~3 MB from R2, once per device | **~$0** (R2 egress free)    |
| D1 rows                                  | ~16 KB print, ~1 KB per cluster                      | **~$0**                     |
| (d) TURN fallback                        | Cloudflare Realtime, a few % of sessions             | cents                       |

One container instance serves many accounts (it is stateless), so cost
grows with hours of mic in use, not with the number of users. Booked as
`speech.voiceprint` in the cost ledger ([payments.md](payments.md)); free to
users for now, like `speech.stt`.

## Milestones (agent hours)

| #   | what                                                                                       | agent h |
| --- | ------------------------------------------------------------------------------------------ | ------- |
| M1  | hub key ring (`kid`), `trust` and `advisory` in the stored tag, tests                      | 3–5     |
| M2  | bands and margins in config; the Mac reads them                                            | 2–3     |
| M3  | `voice_cluster` table, v2 sealing, API, the Mac writes clusters (test phase)               | 6–10    |
| M4  | spike: CAM++ int8 in onnxruntime-web on his iPhone, size, latency, score shift vs fp32     | 4–8     |
| M5  | container image (CAM++ + SenseVoice), DO, `/api/voiceprint/verify`, Worker signing         | 10–16   |
| M6  | A/B on his finals (`service` vs `mac`), then the route race                                | 3–5     |
| M7  | browser extractor in the mic path, avatars from `device` tags                              | 6–10    |
| M8  | consent screen (i18n with context, 16 locales), export, retention sweep, delete-all-voices | 8–12    |
| M9  | legal review, then `voiceprint.public`                                                     | owner   |

Total about 42–69 agent hours before M9. M1–M3 do not depend on the
others; M5 depends on M1.

## Open questions, with recommended defaults

1. **Should the container also decode text** (SenseVoice), so service proofs
   can cover the words? _Default: yes_ (`standard-1`). Without it, service
   proofs are speaker-only and cannot back approvals.
2. **Default upload mode for new users?** _Default: `when-needed`_ (most audio
   stays on the device).
3. **Liveness for voice approvals** (a played recording of him)? _Default:
   approvals also need a spoken one-time phrase shown on screen, checked
   against the signed text._
4. **Key for sealing:** keep deriving from `AUTH_SECRET`, or a dedicated
   `VOICEPRINT_KEK`? _Default: a dedicated secret,_ so rotating
   `AUTH_SECRET` (sessions) does not destroy every print.
5. **Unnamed cluster lifetime?** _Default: 30 days unheard._ Named and
   household: until deleted.
6. **Should a household member's own account ever link to his cluster of
   her?** _Default: no, never._ Accounts stay separate.
7. **Browser model:** int8 CAM++ or fp32 (28 MB)? _Default: int8,_ if M4 shows
   the score shift is ≤ 0.02 on his clips; otherwise fp32, fetched only after
   consent.
8. **Retire the Mac signer?** _Default: no._ It stays as `mac`, free and
   his own; the service covers the times it is off.
9. **Region for the container** (APPI / GDPR transfers)? _Default: let
   Cloudflare place it,_ audio transient and in memory only; revisit
   before `voiceprint.public`.

## Sources

- Workers AI model catalogue: https://developers.cloudflare.com/workers-ai/models/ (2026-11-19)
- Containers pricing: https://developers.cloudflare.com/containers/pricing/
- Containers FAQ (cold starts): https://developers.cloudflare.com/containers/faq/
- Cold-start benchmark: https://alchemy.run/blog/2026-07-01-microvm-cold-starts/
- sherpa-onnx (WASM speaker ID): https://github.com/k2-fsa/sherpa-onnx
- In this repo: [local-stt.md](local-stt.md), [voice-mode.md](voice-mode.md),
  [recordings.md](recordings.md), [secrets-and-auth.md](secrets-and-auth.md),
  [payments.md](payments.md), `lib/speaker-proof.ts`

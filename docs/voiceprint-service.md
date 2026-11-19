# Voiceprint as a service

**Status:** design. M1, the hub's key ring, is built (PR #1008); its second
signer is still named `otoji` and must be renamed `service` (below).

**What the owner asked for, 2026-11-19:**

- ~14:40 JST: the voiceprint (speaker identification) must be a proper
  service, not a script that only runs on his Mac, and must not depend on
  Tailscale or similar network infrastructure.
- Earlier the same day: speaker clusters should eventually live in each
  person's own account (test phase: on his Mac).
- 15:05 JST, the boundary: "Lianki's voice-related services must be provided
  by Lianki's own domain and Cloudflare resources; otoji only provides the SDK
  and packages." otoji is used as a **git submodule** in Lianki.
- He accepted the nine defaults under "Defaults".

Today's system is in [local-stt.md](local-stt.md) ("Voiceprint", "Household
voices", "Speaker clusters") and [voice-mode.md](voice-mode.md) ("Speaker
clusters").

## In one screen

- **Lianki runs the service**: its domain (`lianki.com/api/voice/*`), its
  Cloudflare account, its secrets, its storage. That covers the container,
  the signing key (key id **`service`**), the prints and clusters in **D1**,
  config, consent, credits.
- **otoji provides code only**: the browser extractor package and the
  server/container code (the CAM++ / SenseVoice wrapper). It is mounted at
  `vendor/otoji` as a git submodule, pinned to a commit. otoji.org hosts
  nothing for Lianki.
- **One service, so no cross-service plumbing.** The verify socket uses
  Lianki's normal session cookie or API token. Costs go through
  `metered()`, as every other paid feature does.
- **Two trust levels:**
  1. **In the browser**: otoji's extractor runs CAM++ on the phone. Audio
     never leaves the device. The tag is `device` trust (advisory): avatars,
     clusters, the filter. It never shows the check mark and never counts
     for an approval.
  2. **The Lianki container**: it holds no keys and keeps nothing. It
     decodes text and computes the embedding from one utterance. The Lianki
     voiceprint Worker decides against the sealed print and signs
     (`kid: "service"`). That gives the check mark, and later voice
     approvals.
  3. **His Mac** stays a signer (`kid: "mac"`, today's proofs). It is
     reached over WebRTC through Lianki's signalling, not the tailnet.
- **Workers AI is out**: the catalogue has no speaker-embedding model
  (checked 2026-11-19).

## Who owns what

| part | where | notes |
| --- | --- | --- |
| hub key ring (`mac`, `service`), `trust` / `advisory` | Lianki `lib/speaker-proof.ts`, `workers/push` | built in #1008 as `mac`/`otoji`; rename |
| verify socket, decisions, signing | Lianki `workers/voiceprint` (new), route `lianki.com/api/voice/verify*` | `STT_SPEAKER_KEY` secret |
| container (CAM++ + SenseVoice) | Lianki's Cloudflare account, bound to `workers/voiceprint` | image built from `vendor/otoji` code |
| prints, clusters, household prints, consent | Lianki **D1** (`voiceprint` 0071 + new tables) | sealed with `VOICEPRINT_KEK` |
| panel, avatars, consent screen, i18n, /my | Lianki app | as now |
| account API (`/api/my/voiceprint`, `/api/my/voices`) | Lianki app (`lianki` Worker) | session or token |
| credits | Lianki `metered()`, feature `speech.voiceprint` | free for now |
| model files (CAM++ int8 / fp32, SenseVoice) | Lianki R2 `lianki-blobs` | hashes pinned in otoji's package |
| browser extractor `@otoji/voiceprint-web` | **otoji** (code) | consumed from the submodule |
| server code (`voiceprint-server`: fbank, CAM++, SenseVoice, decide, cluster) | **otoji** (code) | Python; Dockerfile in otoji |
| the Mac's local server | Lianki `scripts/local-stt` now | moves onto the otoji server code (L6) |

## otoji as a submodule

- **Mount: `vendor/otoji`** (`.gitmodules`: `url =
  https://github.com/snomiao/otoji`, public). Not under `packages/`: the root
  `workspaces: ["packages/*"]` would pull in all of otoji, Rust crates and
  demos included. Lianki lists only what it uses:
  `"workspaces": ["packages/*", "vendor/otoji/packages/voiceprint-web"]`, and
  `"@otoji/voiceprint-web": "workspace:*"`.
- **Pinning.** The gitlink in Lianki is the pin: one exact otoji commit. It
  moves only in a Lianki PR (`git -C vendor/otoji checkout <tag>`, commit
  the gitlink), and only to an otoji release tag (otoji uses release-plz).
  The PR body names the tag and the otoji changelog lines. Nothing floats
  on a branch.
- **CI.** Every job that builds or tests runs `actions/checkout@v4` with
  `submodules: true` (public repo, so the default token is enough). Deploy
  jobs do too. Add a fail-fast step: `git submodule status vendor/otoji`
  must not start with `-` (uninitialised) or `+` (off the pin). A shallow
  fetch is fine (`git submodule update --init --depth 1`): otoji's pack is
  about 12 MB.
- **Container image.** `workers/voiceprint/wrangler.jsonc` `containers[].image`
  points at `../../vendor/otoji/voiceprint-server/Dockerfile`, so the image
  is built from the pinned code at deploy. Models are not baked in: the
  container fetches them from R2 at start, checked against the hashes in
  otoji's manifest.
- **Local.** `git submodule update --init vendor/otoji` once. The
  pre-commit and pre-push hooks skip `vendor/otoji` (lint, format, secrets
  scan of a foreign tree), as they already skip the pardon submodule when it
  is not initialised.
- **Note.** [rgui.md](rgui.md) says Lianki vendors without submodules. otoji
  is the owner's explicit exception (2026-11-19), as
  `packages/pardon-could-you-say-it-again` already is.

## What the service does

| op | input | output | caller |
| --- | --- | --- | --- |
| **enrol** | 10–20 read sentences | a print: embeddings, centroid, self scores | Voiceprint panel, after consent and a passkey |
| **verify** | one utterance | `me` / `other` / `unknown`, score, reasons, a signed proof | the mic path (`mic.ts`, `local-stt.ts`) |
| **cluster** | an `other` utterance's embedding | a stable label (`A`, `B`…, `household:<name>`) | verify; the browser extractor |
| **household** | clips the user picks of one household voice | a named household print | the panel |
| **export / delete** | a passkey ticket | JSON of the features, or rows gone | the panel, /my, account deletion |

The rules stay as they are now. The noise gate (`short`, `noise`). The bands:
0.28 / 0.18 under 3 s, 0.30 / 0.20 from 3 s. The household margin:
`ME_MARGIN` −0.25, `OTHER_MARGIN` −0.30. Windows, and the split at a speaker
change. The code that applies them lives in otoji's server package. **The
values are Lianki config keys** (below): the Worker passes them to the
container on each call, and the Mac reads them from
`GET /api/my/voiceprint`. So the Mac, the container and the browser use the
same numbers, and the owner can change them at /dev/config.

## Auth and credits: Lianki's own

- **Session or token.** The verify socket at `wss://lianki.com/api/voice/verify`
  is a Worker route on Lianki's zone. `workers/voiceprint` resolves the caller
  once per socket through a service binding to `lianki` (`MAIN`, as
  `workers/voice` already does): the session cookie, or a Lianki API token
  with the new scope `voice:print` (`lib/api-tokens.ts`, never a default).
  The account comes from that, never from the request. The `thread` is the
  one the page names in its hello, checked against the account's own threads.
- **Passkey ops** (enrol, export, restore, delete) need the existing
  voiceprint passkey ticket (`aud: "lianki-voiceprint"`, `uv: true`, once,
  60 s) and the ten-minute grant (`voiceprint.passkeyWindowMs`), unchanged.
- **Credits.** Each signed verify is one `metered()` call, feature
  `speech.voiceprint` (usage group "stt"). The price is 0 for now, like
  `speech.stt`, but it is still booked at cost, with a daily cap
  `voice.printDailyMax`. Over the cap, or with no credits once a price is
  set: the Worker still decides but does not sign (`unknown`, `quota`).
  Browser-only tags cost nothing and are not metered.
- **Dropped from the previous draft:** the Lianki-signed session ticket to
  otoji (`LIANKI_OTOJI_KEY`), `/api/otoji/voice-session`, `/api/voice/usage`
  and the account-deletion callback. They existed only because otoji was a
  separate service.

## Where the prints live: Lianki D1

There is one service now, so the D1 `voiceprint` table (0071) stays where it
is, and the new tables sit beside it:

| table | rows | sealed payload |
| --- | --- | --- |
| `voiceprint` (exists) | own print per device and model | centroid, embeddings, self scores |
| `voice_cluster` (new) | voices this account heard | centroid, n, first/last heard, label, optional name |
| `voice_household` (new) | named household prints | as a print, `kind: household` |
| `voiceprint_consent` (new) | version, time, upload mode | clear (it is the record) |

**Why D1 over a Durable Object per account.** The rows already exist, and
nothing moves. Every other per-account private table (recordings, voice
clone) uses the same `user_id` pattern. Account deletion, export and the
admin tooling already work on D1. The verify Worker reads the print once per
socket and keeps it in memory for that socket, so D1's latency costs one read
per conversation, not one per utterance. A DO per account would give
structural isolation, but at the price of a second storage model.

**Sealing.** A dedicated Worker secret, `VOICEPRINT_KEK` (default 4), with a
key per account:
`HKDF-SHA256(VOICEPRINT_KEK, salt "lianki/voiceprint", info "lianki/voiceprint/v2/" + uid)`.
The AAD is `voiceprint | uid | kind | device | model | row id`. Today's v1
rows (from `AUTH_SECRET`) stay readable and are re-sealed as v2 on their next
write. Rotating `AUTH_SECRET` then no longer destroys prints. Size: a print
is ~16 KB sealed, a cluster ~1 KB.

## Hosting options, compared

| | (a) Workers AI | (b) Containers | (c) In browser | (d) WebRTC node |
| --- | --- | --- | --- | --- |
| speaker model | **none** | CAM++ (otoji code) | CAM++ int8 (otoji package) | CAM++ |
| audio leaves device | — | yes, transient | **no** | yes, to that node |
| can sign "me" | — | **yes** (Lianki Worker key) | **no** (see Trust) | yes (node key) |
| works with his Mac off | — | **yes** | **yes** | no |
| needs Tailscale | — | no | no | no (Lianki signalling) |
| cold start | — | ~2–3 s, tail to tens of s | model load once per page | ICE ~1–6 s |
| cost | — | ~$1–5 / month (below) | ~0 | ~0 + TURN |

### (a) Cloudflare Workers AI: not possible today

The model catalogue
([developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models/),
read 2026-11-19) has 76 models. Its audio models are ASR (`whisper`,
`whisper-large-v3-turbo`, `whisper-tiny-en`, `nova-3`, `flux`), TTS (`aura-1`,
`aura-2-en`, `aura-2-es`, `melotts`) and `smart-turn-v2`. It has **no
speaker embedding, verification or diarization model**: no pyannote,
ECAPA, CAM++, WeSpeaker or TitaNet. `embeddinggemma-2` takes audio, but it is
a general multimodal embedding, not trained to separate speakers. Re-check
once a quarter. Workers AI does not take custom models.

### (b) Cloudflare Containers on Lianki's account

The container runs otoji's `voiceprint-server` (sherpa-onnx: CAM++ and
SenseVoice) behind a Durable Object, bound to `workers/voiceprint`.

- **Size.** CAM++ zh-en is 28 MB (fp32, 192-dim), with about 150 MB more RAM
  at peak (measured on the Mac). With SenseVoice-Small int8 (~230 MB) for the
  text (default 1), it fits `standard-1` (½ vCPU, 4 GiB).
- **Speed.** On the Mac, CAM++ takes ~6 ms per audio second at normal
  priority. A shared x86 vCPU is perhaps 2–4× slower (**estimate**, measured
  in L3): ~50–150 ms for a 5 s utterance.
- **Cold start.** Cloudflare documents 1–3 s
  ([FAQ](https://developers.cloudflare.com/containers/faq/)). An independent
  2026 benchmark saw a median of ~2 s with a tail up to ~50 s
  ([alchemy.run](https://alchemy.run/blog/2026-07-01-microvm-cold-starts/)).
  So one instance stays warm while any mic is on (the socket's hello wakes
  it) and sleeps after `voiceprint.containerIdleS` (300 s). A final that
  arrives during a cold start is `unknown` (`cold`), never blocked.
- **Stateless.** The container gets audio and the config values. It returns
  `{embedding, text, speechS, snrDb}`. It never sees a print, a key or an
  account id. Placement is Cloudflare's choice, with audio in memory only
  (default 9).

### (c) In the browser: `@otoji/voiceprint-web`

otoji's package, bundled by Lianki from the submodule. It loads its model
from **Lianki's R2** (`lianki.com/api/voice/model/<hash>`, immutable, cached
by Lianki's service worker), never from otoji.org.

- **Model.** CAM++ int8 ≈ 7–8 MB, if O1 shows a score shift of ≤ 0.02 on his
  clips; otherwise fp32 (28 MB), fetched only after consent (default 7). The
  package wraps sherpa-onnx's WASM build
  ([k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)) or
  onnxruntime-web with its own fbank.
- **Runtime.** SIMD WASM, roughly 10 MB uncompressed and ~3 MB over the wire
  (**estimate**). It loads only after the mic is on, never on page load
  ([cold-start.md](cold-start.md)).
- **Latency on a phone.** Perhaps 3–8× slower than on the Mac
  (**estimate**): 60–250 ms for a 3–5 s utterance, in a Web Worker beside
  the STT round trip. The line shows first and the avatar follows, so the
  0.2 s feedback rule holds.
- **What goes up.** Only the 192 floats (768 bytes) per utterance, to
  `/api/my/voices`, and only when clusters are kept in the account. Never
  audio.

### (d) WebRTC to a recognition node

Lianki's own `SttRegistry` (`lianki-push`, `lianki.com/api/version/stt/signal`)
relays SDP/ICE, and the node dials **out** (`stt-peer`, pion). TURN is
Cloudflare Realtime on Lianki's account. There is no inbound port and no
Tailscale. This is good for **his own Mac**: free compute, his own key,
today's proofs. It is not a service by itself, because a node must be
online.

### Recommendation

**(c) for everything that needs no trust, (b) for the signed tag, (d) kept
for his Mac.** All three run on Lianki's domain and account, on otoji's
code.

- **Privacy:** most utterances, and every voice that is not enrolled, never
  send audio anywhere for the voiceprint.
- **Trust:** only a party that heard the audio can sign "his voice said
  these words".
- **Independence:** neither his Mac nor Tailscale is needed.
- **Cost:** near zero apart from the container's awake hours.

## Trust: who may sign "me"

Today the Mac signs `{v:1, uid, thread, at, text, decision, score, model,
device, …}` with `speaker-attest.key`, and the hub checks it. That works
because the Mac **heard the audio and decoded the text itself**.

**The browser cannot self-sign.** Page code (eval, an extension, a script)
can read any key in the page. Even a perfect model can be fed a recording,
or skipped and the stored centroid sent instead. A server that receives
only an embedding cannot tell. So a browser tag is `trust: "device"`, stored
as `speaker.advisory`, separate from `speaker`. It never shows the check and
never backs an approval.

**Lianki signs, without the Mac's key.**

```
page ─ WSS lianki.com/api/voice/verify {uid, thread, pcm} (session / voice:print token) ─▶ workers/voiceprint
workers/voiceprint ─ container binding ─▶ {embedding, text, speechS, snrDb}     (no key, no print)
workers/voiceprint: print from D1 (opened once per socket), decide, metered(), sign with STT_SPEAKER_KEY
     ◀─ final {text, speaker, speakerProof: kid "service"} ─
```

- **`STT_SPEAKER_KEY`** is an Ed25519 private key, a secret on
  `lianki-voiceprint`. Its public half is in the hub's `STT_SPEAKER_PUBS` as
  `service`. The container never holds it.
- **Text binding.** The proof signs the text the container decoded from the
  same audio (default 1). If the line used other text (the cloud Whisper
  fallback, a cleanup), the hub keeps the speaker as advisory only.
  Approvals need a signed text.
- **A replayed recording** is a weakness for every signer. Approvals also
  need a one-time phrase shown on screen and spoken (default 3).
- **The key ring rename.** #1008 shipped `SPEAKER_KIDS = ["mac", "otoji"]`
  and a combined kid `"mac+otoji"`. Rename these to `service` and
  `"mac+service"` in `lib/speaker-proof.ts`, `packages/debug-chat/src/wire.ts`,
  `workers/push/src/debug.ts`, the unit tests and the notes in
  [local-stt.md](local-stt.md) and [secrets-and-auth.md](secrets-and-auth.md).
  No `otoji` key was ever set and no stored tag names it, so the rename
  needs no migration and no alias (L1).

## When the audio goes up

The user picks this on the consent screen:

| mode | what goes to the container | what you get |
| --- | --- | --- |
| **device only** | nothing | avatars, clusters, filter; no check mark |
| **signed when needed** (default 2) | lines sent to an agent, approvals | the check on those lines |
| **signed always** | every final | the check on every line |

On his account, signing goes to his Mac when it is reachable and to the
service otherwise (`voiceprint.signers`).

## Biometric data

### Other people's voices: "people I hear"

- **A cluster belongs to the account that heard it.** His wife's voice on
  his phone is a row in **his** account. It is never her print, even if she
  has an account. Lianki never compares one account's rows with another's,
  and there is no global voice index. Every statement carries the caller's
  `user_id`, as recordings do.
- **A household print** is a cluster he promoted and named. The name is
  typed by the user, never taken from anyone's account, and it is never
  linked to that person's account (default 6).
- **Unnamed clusters** are forgotten after 30 days without being heard
  (default 5). Named and household ones stay until deleted.

### Consent, retention, delete, export

- **Consent screen** (Lianki, versioned, recorded in `voiceprint_consent`).
  It says:
  - what an embedding is: numbers, not a recording;
  - that it is kept encrypted in **your** Lianki account;
  - the upload mode;
  - that other voices nearby become unnamed clusters in your account;
  - how long things are kept, and how to delete and export them.

  Buttons: "I agree, start" and "Not now". Without consent there is no print
  and no clusters, and the mic works as before.
- **Retention.** The own print is kept until deleted, or until 1095 days pass
  without a verify (with a mail 30 days before). Clusters as above.
  Deleting the account deletes all of it.
- **Delete.** As now: one passkey ticket, and the Mac and the account both.
  Add "Delete all voices I hear". Recordings are never deleted silently;
  that stays a separate question.
- **Export.** `GET /api/my/voiceprint?export=1` (session and passkey ticket)
  returns one JSON with prints and clusters, decrypted, with the model and
  dimension.

### Legal note (factual, not advice)

- **Japan, APPI.** Voiceprint data converted so it can identify a person is
  an "individual identification code" (個人識別符号), so it is personal
  information on its own. It is not special-care (要配慮個人情報). The
  purpose must be stated, and passing it to a third party needs consent. One
  service on Lianki's account keeps it inside Lianki. Cloudflare is the
  processor, as it already is for recordings.
- **EU/UK, GDPR Art. 9.** Biometric data processed "for the purpose of
  uniquely identifying a natural person" is special-category data. The usual
  basis is explicit consent (Art. 9(2)(a)). Bystanders' clusters are the
  hard case: the user's household use may be exempt (Art. 2(2)(c)), but the
  service is not.
- **US, Illinois BIPA** (if US users join): written consent before
  collection, and a public retention schedule with destruction within 3
  years of the last interaction. The 1095-day default comes from this.
- **So:** an explicit consent screen; a published retention policy; clusters
  that only distinguish voices and never identify them unless the user names
  them; no cross-account matching. Counsel should review before
  `voiceprint.public`.

## Migration without breaking today

His flow today: phone → tailnet, `stt.lianki.com` or WebRTC → the Mac's
proof → the hub. It keeps working at every step:

1. **Key ring rename** (`otoji` → `service`). The Mac is unchanged.
2. **Submodule.** Add `vendor/otoji`, update CI checkout, and pin an otoji
   release with the first packages.
3. **Config, D1 tables and v2 sealing.** The Mac reads the bands from config
   and writes its clusters (memory today) to `/api/my/voices`, so their
   labels survive midnight and restarts.
4. **The service beside the Mac.** It joins the route race after his Mac,
   and he compares both on the same finals (devLog `speaker-ab`) before
   anything relies on `service`.
5. **Browser extractor**, behind its flag, for avatars first.
6. **Tailscale optional.** His default route list becomes `rtc:mac,
   service`.

**Flags** (positive names; owner audience, ON for him when shipped):

| flag | on means |
| --- | --- |
| `voiceprint.service` | the Lianki verifier (container + signing) is offered |
| `voiceprint.browser-embed` | the page computes embeddings with `@otoji/voiceprint-web` |
| `voiceprint.account-clusters` | clusters are kept in the account, not just in memory |
| `voiceprint.public` | accounts without `dev` may enrol (default off: biometric, like recordings) |

**Config keys** (`lib/config.ts`, defaults only):

| key | default | note |
| --- | --- | --- |
| `voiceprint.extractor` | `mac` | add `browser`, `service` |
| `voiceprint.signers` | `["mac","service"]` | race order for a signed tag |
| `voiceprint.uploadMode` | `when-needed` | `device` / `when-needed` / `always` |
| `voiceprint.bands` | today's table | me/other per length, SNR gate |
| `voiceprint.householdMargins` | `{me:-0.25, other:-0.30}` | |
| `voiceprint.clusterSame` / `clusterMax` | 0.30 / 8 | |
| `voiceprint.clusterForgetDays` | 30 | unnamed clusters |
| `voiceprint.printUnusedDays` | 1095 | own print |
| `voiceprint.containerIdleS` | 300 | container sleep |
| `voice.printDailyMax` | 2000 | signed verifies per account per UTC day |

**Secrets** (all on Lianki's account, each set only after his tap card):

- `STT_SPEAKER_KEY` on `lianki-voiceprint`.
- `STT_SPEAKER_PUBS` with `service`, on `lianki-push`.
- `VOICEPRINT_KEK` on `lianki` and `lianki-voiceprint`.

## Cost

List prices, read 2026-11-19
([Containers pricing](https://developers.cloudflare.com/containers/pricing/)):

- vCPU: $0.000020 / s (375 vCPU-min free per month).
- Memory: $0.0000025 / GiB-s (25 GiB-h free).
- Disk: $0.00000007 / GB-s (200 GB-h free).
- Billed per 10 ms while running; sleeping costs nothing.
- Lianki's Workers Paid plan is already paid.

| item | assumption | per month |
| --- | --- | --- |
| container `standard-1` (4 GiB) | mic on 4 h/day → 480 GiB-h, minus 25 free | ≈ **$4.10** |
| (embeddings only, `basic` 1 GiB) | the same hours, 120 − 25 GiB-h | ≈ $0.86 |
| container CPU | ~0.1 vCPU-s per 5 s utterance, 2,000 / day | 100 vCPU-min, **free tier** |
| browser extractor | model ~8 MB + runtime ~3 MB from R2, once per device | **~$0** (R2 egress free) |
| D1 rows | ~16 KB print, ~1 KB per cluster | **~$0** |
| TURN fallback for (d) | Cloudflare Realtime, a few % of sessions | cents |

The container is stateless and shared, so cost grows with hours of mic in
use, not with users. It is booked as `speech.voiceprint`
([payments.md](payments.md)).

## Milestones, by repo (agent hours)

**Lianki: the services.**

| # | what | agent h |
| --- | --- | --- |
| L1 | rename the key ring's `otoji` → `service` (code, wire, hub, tests, docs) | 1–2 |
| L2 | `vendor/otoji` submodule, workspaces entry, CI `submodules: true` + pin check, hooks skip | 2–3 |
| L3 | `workers/voiceprint`: route, `MAIN` auth, container binding, decide, sign, `metered()`, cap | 8–12 |
| L4 | D1 tables, v2 sealing with `VOICEPRINT_KEK`, `/api/my/voices`, config keys; Mac reads bands, writes clusters | 6–9 |
| L5 | panel and mic path: route race `rtc:mac, service`, A/B devLog, browser extractor wired, avatars from `device` tags | 6–10 |
| L6 | consent screen (i18n with context, 16 locales), export, delete-all-voices, retention sweep; the Mac server on otoji's code | 6–10 |

Lianki total: **29–46 h**.

**otoji: the packages (code only).**

| # | what | agent h |
| --- | --- | --- |
| O1 | `@otoji/voiceprint-web`: spike on his iPhone (size, latency, int8 shift), then the package, model manifest with hashes | 8–14 |
| O2 | `voiceprint-server`: fbank + CAM++ + SenseVoice wrapper, decide / cluster as pure functions taking config, Dockerfile, tests from `test_voiceprint.py` | 6–10 |
| O3 | a release tag for Lianki to pin; changelog | 1 |

otoji total: **15–25 h**.

**Order.** L1 now. O2, then O3, then L2. L3 needs L2. L4 can run beside
them. O1 at any time; L5 needs it and L3. L6 last. Then the legal review
(the owner), and only then `voiceprint.public`.

## Defaults (accepted by the owner, 2026-11-19)

1. **The container also decodes text** (SenseVoice), so `service` proofs
   cover the words.
2. **The default upload mode for new users is `when-needed`.**
3. **Liveness for approvals**: a one-time phrase shown on screen, spoken,
   and checked against the signed text.
4. **A dedicated sealing key**, not `AUTH_SECRET`: `VOICEPRINT_KEK`, a
   Lianki secret.
5. **Unnamed clusters are forgotten after 30 days unheard**; named and
   household ones stay until deleted.
6. **A household member's own account is never linked** to his cluster of
   her.
7. **The browser model is int8 CAM++** if the shift is ≤ 0.02, otherwise fp32
   after consent.
8. **The Mac signer stays** (`mac`).
9. **The container region is Cloudflare's choice**, with audio in memory
   only; revisit before `voiceprint.public`.

## The three questions from the otoji draft, resolved

- **Which Cloudflare account?** Lianki's, for every service. otoji's account
  hosts nothing for Lianki.
- **Where `server.py` / `voiceprint.py` live.** The model code moves into
  otoji's `voiceprint-server` (O2). Lianki's container and the Mac's local
  server both run it from `vendor/otoji`. Lianki's Mac-specific parts (the
  tailnet and tunnel listeners, tickets, the attest key) stay in
  `scripts/local-stt`.
- **Hostname.** `lianki.com/api/voice/*`, on Lianki's zone, routed to
  `workers/voiceprint`. The existing `/api/my/voiceprint` stays in the app.

## Sources

- Workers AI model catalogue: https://developers.cloudflare.com/workers-ai/models/ (2026-11-19)
- Containers pricing: https://developers.cloudflare.com/containers/pricing/
- Containers FAQ (cold starts): https://developers.cloudflare.com/containers/faq/
- Cold-start benchmark: https://alchemy.run/blog/2026-07-01-microvm-cold-starts/
- sherpa-onnx (WASM speaker ID): https://github.com/k2-fsa/sherpa-onnx
- In this repo: [local-stt.md](local-stt.md), [voice-mode.md](voice-mode.md),
  [recordings.md](recordings.md), [secrets-and-auth.md](secrets-and-auth.md),
  [payments.md](payments.md), `lib/speaker-proof.ts`, `workers/voice` (the
  `MAIN` service-binding pattern)

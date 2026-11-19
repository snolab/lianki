# Voiceprint as a service (in otoji)

**Status: design, nothing built** (apart from the hub key ring, M1, which is
in progress). The owner asked on 2026-11-19 (~14:40 JST) for the voiceprint
(speaker identification) to become a proper service, not a script that only
runs on his Mac, and said it must not depend on Tailscale or similar network
infrastructure. Earlier the same day he said speaker clusters should
eventually live in each person's own account (test phase: on his Mac). At
~14:58 JST he moved it: **the service lives in otoji** (otoji.org, its
`/signal` Worker, its WebRTC recognition nodes), because all voice things go
to otoji. **Lianki is a consumer.** He accepted the nine defaults under "Open
questions".

Today's system is in [local-stt.md](local-stt.md) ("Voiceprint", "Household
voices", "Speaker clusters") and [voice-mode.md](voice-mode.md) ("Speaker
clusters"). This doc covers what changes, what moves to otoji, and what stays
in Lianki.

## In one screen

- **otoji hosts the service.** That means the container that computes text
  and embeddings, the signing key (key id **`otoji`**), the in-browser
  extractor package, and the storage of prints and clusters.
- **Lianki keeps** the hub's key ring (`mac`, `otoji`), its own UI (the
  Voiceprint panel, avatars, the consent screen it shows), the accounts and
  the credits. otoji has no accounts. It learns the account from a **scoped
  Lianki token**, as the otoji mic polish proxy already does
  (`docs/mic-polish-api.md`, Lianki PR #1001).
- **Prints and clusters are stored in otoji**, keyed by the Lianki account id,
  in **one Durable Object per account** (its SQLite storage), sealed with an
  otoji key. Lianki's D1 `voiceprint` rows move there once and are then
  deleted ("Where the prints live" explains the choice).
- **Two trust levels, as before:**
  1. **In the browser.** otoji's extractor package runs CAM++ on the phone
     (onnxruntime-web). Audio never leaves the device. The tag is `device`
     trust: it drives avatars, clusters and the filter, never the green
     check, never an approval.
  2. **The otoji container**, which holds no keys and stores nothing. It
     decodes text and computes the embedding from one utterance's audio. The
     **otoji Worker** decides against the sealed print and signs (`kid:
     "otoji"`). This is the check mark, and later voice approvals.
  3. **His Mac** stays a signer (`kid: "mac"`, today's proofs). It is reached
     over WebRTC through signalling, not the tailnet.
- **Workers AI is out**: the catalogue has no speaker-embedding model
  (checked 2026-11-19).
- **Nothing breaks on the way**: the hub accepts `mac` and `otoji`. A proof
  without `kid` is `mac`.

## Who owns what

| part | repo | notes |
| --- | --- | --- |
| hub key ring, `trust` / `advisory` on stored tags | **Lianki** (`lib/speaker-proof.ts`, `workers/push`) | M1, in progress |
| Voiceprint panel, avatars, consent screen UI, i18n | **Lianki** | shows otoji's consent text and version |
| accounts, passkey tickets, credits, daily caps | **Lianki** | otoji never holds an account |
| token scope `voice:print`, the otoji session ticket | **Lianki** | like `mic:polish` |
| verify / enrol / cluster API, decisions, signing | **otoji** Worker | `otoji.org/voice/*` |
| container (CAM++ + SenseVoice) | **otoji** | keyless, stateless |
| browser extractor (`@otoji/voiceprint-web`) and model files | **otoji** | npm package; model on otoji R2 |
| prints, clusters, household prints, consent records | **otoji** (DO per account) | sealed with `OTOJI_VOICEPRINT_KEK` |
| the Mac's local server (`server.py`, `voiceprint.py`) | Lianki (`scripts/local-stt`) for now | a signer and a test bed; may move to otoji later |

## What the service does

| op | input | output | caller |
| --- | --- | --- | --- |
| **enrol** | 10–20 read sentences (audio or embeddings) | a print: embeddings, centroid, self scores | Lianki's Voiceprint panel, after consent and a passkey |
| **verify** | one utterance | `me` / `other` / `unknown`, score, reasons, signed proof | Lianki's mic path (`mic.ts`, `local-stt.ts`) |
| **cluster** | an `other` utterance's embedding | a stable label (`A`, `B`…, `household:<name>`) | verify, as a side output; the browser extractor |
| **household** | clips the user picks of one household voice | a named household print | the panel ("This is a household voice") |
| **export / delete** | a passkey ticket | JSON of the features, or rows gone | the panel, Lianki /my, Lianki account deletion |

The rules stay as they are now: the noise gate (`short`, `noise`), the bands
(0.28 / 0.18 under 3 s, 0.30 / 0.20 from 3 s), the household margin
(`ME_MARGIN` −0.25, `OTHER_MARGIN` −0.30), windows and the split at a speaker
change. They become otoji config (Worker vars, served at
`GET otoji.org/voice/config`), so the Mac, the container and the browser read
the same numbers.

**Callers.**

- **Lianki's browser mic path** calls verify for each final. It uses the
  in-browser embedding first (fast, private) and the otoji verifier when a
  signed tag is needed ("When the audio goes up").
- **Lianki's hub** (`lianki-push`, `lib/speaker-proof.ts`) never calls otoji.
  It only checks proofs, against the key ring.
- **Lianki's Voiceprint panel** handles enrol, household, export and delete.
  The calls go to otoji with the session ticket below.

## Accounts and credits come from Lianki

otoji has no accounts. It works the way the mic polish proxy does
(`docs/mic-polish-api.md`, PR #1001): Lianki issues a token, otoji acts
for that account, and Lianki charges it.

```
Lianki page ─ POST lianki.com/api/otoji/voice-session (session cookie) ─▶ Lianki Worker
            ◀─ ticket {aud:"otoji-voice", sub:<lianki uid>, scope:["voice:print"], thread, exp ≤ 10 min}  (Ed25519, LIANKI_OTOJI_KEY)
page ─ WSS otoji.org/voice/verify {ticket, uid, pcm…} ─▶ otoji Worker: verify ticket offline (Lianki public key)
otoji Worker ─ POST lianki.com/api/voice/usage {ticket jti, audioMs} (Bearer, service token) ─▶ Lianki: credits + daily cap
```

- **The scope** is `voice:print`, a new Lianki token scope (`lib/api-tokens.ts`).
  It is never a default, and is offered at /my/preferences → API tokens for
  agents and devices that call otoji directly.
- **The ticket** is short-lived and signed by Lianki, so otoji can check it
  without a round trip on every utterance. It is the same shape as the STT v2
  ticket. Its `sub` is the account. otoji never takes an account from a
  request body.
- **Passkey ops** (enrol, export, restore, delete) still need Lianki's
  voiceprint passkey ticket (`aud: "lianki-voiceprint"`, `uv: true`, once,
  60 s; [local-stt.md](local-stt.md), "Who may enrol and delete"). otoji
  checks it with `STT_TICKET_KEY`'s public half and burns its `jti` in the
  account's DO. The ten-minute grant (`voiceprint.passkeyWindowMs`) stays
  in Lianki.
- **Credits.** otoji books each verified utterance with Lianki
  (`speech.voiceprint`, usage group "stt"). The price is free for now, like
  `speech.stt`, with a daily cap per account (`voice.printDailyMax`, the
  same atomic counter as `mic.polishDailyMax`). If Lianki answers 402 or 429,
  otoji still decides but does not sign (`unknown`, `quota`). Booking is
  asynchronous and never delays a final.
- **Account deletion** in Lianki calls `DELETE otoji.org/voice/account` with
  a service credential. otoji deletes that account's DO storage and
  answers with a count. Lianki retries until it gets an answer.

## Where the prints live: otoji, one Durable Object per account

There are two options:

| | in otoji (DO per Lianki uid) | stay in Lianki D1 |
| --- | --- | --- |
| verify latency | print read in the same DO, no hop | a Lianki round trip per socket (≈ 20–80 ms) |
| "all voice things in otoji" | **yes** | no: biometric data split across two services |
| cross-account isolation | **structural**: one DO per account, no query spans two | by `WHERE user_id = ?` in every statement |
| delete / export | `storage.deleteAll()` / one read | as today |
| what otoji must build | sealing, a DO class, retention alarms | nothing; but otoji would need a read API into Lianki |

**Recommendation: otoji, one DO per account** (`VoiceAccount`, id =
`idFromName("lianki:" + uid)`, so another issuer can be added later without a
clash). Its SQLite tables: `print` (device, model), `cluster`, `household`,
`consent`, `used_jti`. Payloads are AES-256-GCM, sealed with
`HKDF(OTOJI_VOICEPRINT_KEK, salt "otoji/voiceprint", info "otoji/voiceprint/v1/lianki:" + uid)`.
The AAD is kind, device, model and row id. `OTOJI_VOICEPRINT_KEK` is a new
otoji Worker secret, not derived from Lianki's `AUTH_SECRET` (default 4).
Retention runs on the DO's alarm.

**Migration of today's rows.** Lianki's D1 `voiceprint` (0071) holds his
prints, sealed with Lianki's key. These steps run once, under one passkey
ticket: Lianki opens the rows, sends the features to the account's otoji DO
(`op: "restore"`), and reads them back to compare. After his tap card it
deletes the D1 rows. `/api/my/voiceprint` then forwards to otoji, or answers
404 once the panel talks to otoji directly.

## Hosting options, compared

| | (a) Workers AI | (b) Containers | (c) In browser | (d) WebRTC node |
| --- | --- | --- | --- | --- |
| speaker model | **none** | CAM++ (ours) | CAM++ int8 | CAM++ (ours) |
| audio leaves device | — | yes, transient | **no** | yes, to that node |
| can sign "me" | — | **yes** (otoji Worker key) | **no** (see Trust) | yes (node key) |
| works with his Mac off | — | **yes** | **yes** | no, unless other nodes |
| needs Tailscale | — | no | no | no (signalling) |
| cold start | — | ~2–3 s, tail to tens of s | model load once per page | ICE ~1–6 s |
| cost | — | ~$1–5 / month (below) | ~0 | ~0 + TURN |

All of (b), (c) and (d) are in otoji now. (b) is a container behind the otoji
Worker. (c) is an otoji package. (d) is otoji's recognition-node network.

### (a) Cloudflare Workers AI: not possible today

The model catalogue
([developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models/),
read 2026-11-19) has 76 models. Its audio models are ASR (`whisper`,
`whisper-large-v3-turbo`, `whisper-tiny-en`, `nova-3`, `flux`), TTS (`aura-1`,
`aura-2-en`, `aura-2-es`, `melotts`) and `smart-turn-v2`. There is **no
speaker embedding, verification or diarization model**: no pyannote, ECAPA,
CAM++, WeSpeaker or TitaNet. `embeddinggemma-2` takes audio, but it is a
general multimodal embedding: it is not trained to separate speakers, and its
scores would need a calibration we do not have. Re-check once a quarter.
Workers AI does not take custom models.

### (b) Cloudflare Containers (otoji) running CAM++ and SenseVoice

The same sherpa-onnx models as the Mac, in an otoji container image behind a
Durable Object, called only by the otoji Worker.

- **Size.** CAM++ zh-en is 28 MB (fp32, 192-dim), with about 150 MB more RAM
  at peak (measured on the Mac). With SenseVoice-Small int8 (~230 MB) for the
  text (default 1), it fits `standard-1` (½ vCPU, 4 GiB).
- **Speed.** On the Mac, CAM++ takes ~6 ms per audio second at normal priority
  (~18 ms in the background). A shared x86 vCPU is perhaps 2–4× slower
  (**estimate**, measured in O2): ~50–150 ms for a 5 s utterance.
- **Cold start.** Cloudflare documents 1–3 s
  ([FAQ](https://developers.cloudflare.com/containers/faq/)). An independent
  2026 benchmark saw a median of ~2 s with a tail up to ~50 s
  ([alchemy.run](https://alchemy.run/blog/2026-07-01-microvm-cold-starts/)).
  So: keep one instance warm while any mic is on (the verify socket's hello
  wakes it), and let it sleep after `voice.containerIdleS` (300 s). A final
  that arrives during a cold start is `unknown` (`cold`), never blocked.
- **Stateless.** The container gets audio and returns `{embedding, text,
  speechS, snrDb}`. It never sees a print, a key or an account id. Placement:
  Cloudflare's choice, with audio in memory only (default 9).

### (c) In-browser embeddings: `@otoji/voiceprint-web`

CAM++ in the page, published by otoji as an npm package. Lianki bundles it,
and it loads the model from otoji's R2 (versioned, hash-checked). Lianki's
Silero VAD already holds the utterance's 16 kHz samples.

- **Model.** CAM++ int8 ≈ 7–8 MB (a quarter of the fp32 28 MB). Use int8 if
  O3 shows a score shift of ≤ 0.02 on his clips, otherwise fp32, fetched
  only after consent (default 7). sherpa-onnx already has a WASM build with
  speaker ID ([k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)),
  so the package wraps either that build or onnxruntime-web with our own
  fbank.
- **Runtime.** onnxruntime-web's SIMD WASM is roughly 10 MB uncompressed and
  ~3 MB over the wire (**estimate**, measured in O3). It is cached by Lianki's
  service worker ([cold-start.md](cold-start.md)) and loaded only after the
  mic is on, never on page load.
- **Latency on a phone.** Perhaps 3–8× slower than native on the Mac
  (**estimate**): ~20–50 ms per audio second, so 60–250 ms for a 3–5 s
  utterance. It runs in a Web Worker beside the STT round trip; the line
  shows first and the avatar follows, so the 0.2 s feedback rule holds.
- **Memory.** One inference per final, not per frame: ~30 MB more with the
  session loaded. On a phone too slow for it the page falls back to (b), or
  to no tag.
- **What goes up.** Only the 192 floats (768 bytes) per utterance, to the
  account's otoji DO, and only when clusters are kept. Never audio.

### (d) WebRTC to a recognition node

Lianki's `SttRegistry` (`lianki-push`) and otoji's `otoji.org/signal/{room}`
are the same pattern. A DO relays SDP/ICE, the node dials **out**
(`stt-peer`, pion), and Cloudflare Realtime TURN covers symmetric NAT. No
inbound port, no Tailscale.

- Good for **his own Mac**: free compute, his own key. This is today's proof
  path on a different transport.
- Not a service by itself: it needs a node online, and another person's node
  would have to be trusted with their audio and a signing key. Nodes sign
  only for their own owner, and stay `kid: "mac"` (or `node:<id>` later).

### The recommendation and why

**(c) for everything that needs no trust, (b) for the signed tag, (d) kept
for his Mac, all three in otoji.**

- **Privacy:** most utterances, and every voice that is not enrolled, never
  send audio anywhere for the voiceprint.
- **Trust:** a browser cannot prove what it heard (next section). Only a
  party that saw the audio can sign "his voice said these words".
- **Independence:** (b) and (c) need neither his Mac nor Tailscale.
- **Cost:** (c) is free, and (b) runs only when a signed tag is asked for.

## Trust: who may sign "me"

Today the Mac signs `{v:1, uid, thread, at, text, decision, score, model,
device, …}` with `speaker-attest.key`, and the hub checks it against
`STT_SPEAKER_PUB`. That works because the Mac **heard the audio and decoded
the text itself**.

**The browser cannot self-sign.** Any key in the page can be read by page
code (eval, an extension, a script). And even a perfect browser model can be
fed a recording, or skipped, with the stored centroid sent instead. A server
that receives only an embedding cannot tell either case from real speech.
So a browser tag is `trust: "device"`. It may pick an avatar, a cluster
letter and the local filter. **It never shows the check (`VoiceMark`) and
never counts for an approval.** The hub stores it as `speaker.advisory`,
separate from `speaker`.

**otoji signs, without the Mac's key.**

```
page ─ WSS otoji.org/voice/verify {ticket (Lianki), uid, thread, pcm} ─▶ otoji Worker
otoji Worker ─ DO binding ─▶ container: {embedding, text, speechS, snrDb}     (no key, no print)
otoji Worker: account DO opens the sealed print, decides (same bands), signs with OTOJI_SPEAKER_KEY
     ◀─ final {text, speaker, speakerProof: kid "otoji"} ─
```

- `OTOJI_SPEAKER_KEY` is an Ed25519 private key, an **otoji Worker secret**.
  Its public half is in Lianki's hub ring as `kid: "otoji"`. The container
  never holds it.
- **Text binding.** The proof signs the text the container decoded from the
  same audio (default 1). If the page's line used other text (the cloud
  Whisper fallback, a cleanup), the hub keeps the speaker as advisory only.
  Approvals need a signed text.
- **Account binding.** The print is chosen by the Lianki ticket's `sub`, and
  the proof's `thread` comes from the ticket, so a page cannot verify against
  another account or move a proof to another thread.
- **Key ring in the hub (M1).** `STT_SPEAKER_PUBS` = `{"mac": "<b64>",
  "otoji": "<b64>"}`, falling back to `STT_SPEAKER_PUB` as `mac`. A proof
  without `kid` is `mac`. The stored tag records `kid`.
- **A replayed recording** of his voice is a weakness for every signer.
  Approvals also need a one-time phrase shown on screen and spoken, checked
  against the signed text (default 3).

## When the audio goes up

The user picks this on the consent screen:

| mode | what goes to the otoji container | what you get |
| --- | --- | --- |
| **device only** | nothing | avatars, clusters, filter; no check mark |
| **signed when needed** (default 2) | lines sent to an agent, approvals | the check on those lines |
| **signed always** | every final | the check on every line |

On his account, signing goes to his Mac (d) when it is reachable and to
otoji (b) otherwise. The order is Lianki config `voiceprint.signers`.

## Biometric data

### What is stored, and where

Embeddings only, never audio, in the account's otoji DO:

| table | rows | sealed payload |
| --- | --- | --- |
| `print` | own print per device and model | centroid, embeddings, self scores |
| `cluster` | voices this account heard | centroid, n, first/last heard, label, optional name |
| `household` | named household prints | the same as `print`, `kind: household` |
| `consent` | version, time, mode | clear (it is the record) |

Size: a print of 20 × 192 float32 is ~16 KB sealed, a cluster ~1 KB. The
optional enrolment recordings stay in Lianki's My Files, as now. They are
audio, and audio is not part of this service.

### Other people's voices: "people I hear"

- **A cluster belongs to the account that heard it.** His wife's voice on his
  phone is a row in **his** DO, never her print, even if she has an account.
  otoji never compares one account's rows with another's. There is no global
  voice index, and one DO per account makes a cross-account query
  impossible, not just forbidden.
- **A household print** is a cluster he promoted and named. The name is one
  the user types; it is never taken from anyone's account. It is never
  linked to that person's own account (default 6).
- **Unnamed clusters are forgotten** after 30 days without being heard
  (default 5). Named and household ones stay until deleted.
- **Her own account** may enrol her own print, in her own DO, under her own
  consent. It is unrelated to his cluster of her.

### Consent, retention, delete, export

- **Consent screen.** Lianki shows it. The text and its version come from
  otoji (`GET otoji.org/voice/consent`), and otoji keeps the record, because
  otoji holds the data. It says what an embedding is (numbers, not a
  recording), that it is kept by otoji under your Lianki account, the upload
  mode, that other voices nearby become unnamed clusters in **your** account,
  retention, delete and export. The buttons are "I agree, start" and "Not
  now". Without consent there is no print and no clusters, and the mic works
  as before.
- **Retention.** The own print is kept until deleted, or until 1095 days pass
  without a verify (a mail 30 days before, sent by Lianki). Clusters follow
  the rule above. Deleting the Lianki account deletes the DO.
- **Delete.** The flow is as now (one passkey ticket; the Mac and otoji
  both), plus "Delete all voices I hear". It never deletes recordings
  silently; that stays a separate question.
- **Export.** `GET otoji.org/voice/export` (Lianki ticket plus a passkey
  ticket) returns one JSON with prints and clusters, decrypted, with the
  model name and dimension.

### Legal note (factual, not advice)

- **Japan, APPI.** Voiceprint data converted so it can identify a person is an
  "individual identification code" (個人識別符号), so it is personal
  information on its own. It is not in the special-care category
  (要配慮個人情報). The purpose must be stated. Passing it to a third party
  needs consent, and **otoji is a separate service from Lianki**: the
  privacy policy must name otoji as the processor of voice features, and
  the consent screen must name it too.
- **EU/UK, GDPR Art. 9.** Biometric data processed "for the purpose of
  uniquely identifying a natural person" is special-category data. The usual
  basis is explicit consent (Art. 9(2)(a)). Clusters of bystanders are the
  hard case: the user's household use may be exempt (Art. 2(2)(c)), but the
  service is not.
- **US, Illinois BIPA** (if US users join): written consent before
  collection, and a public retention schedule with destruction within 3
  years of the last interaction. That is where the 1095-day default comes
  from.
- **So:** an explicit consent screen naming otoji; a published retention
  policy; clusters only distinguish voices and never identify them unless
  the user names them; no cross-account matching. Counsel should review
  before accounts other than his can enrol.

## Migration without breaking today

His flow today goes phone → tailnet, `stt.lianki.com` or WebRTC → the Mac's
proof → the hub. It keeps working at every step:

1. **Key ring (Lianki M1, in progress).** The hub reads `STT_SPEAKER_PUBS`
   with `mac` and `otoji`. The Mac is unchanged.
2. **Session ticket and usage (Lianki).** `voice:print`,
   `/api/otoji/voice-session`, `/api/voice/usage`.
3. **otoji account storage.** The DO, sealing and API, then a one-time move
   of his D1 prints (above). The Mac's clusters (memory today) are also
   written to his DO in this test phase, so their labels survive midnight
   and restarts.
4. **otoji verifier beside the Mac.** It joins Lianki's route race after his
   Mac. He compares the decisions of both on the same finals (devLog
   `speaker-ab`) before anything relies on `otoji`.
5. **Browser extractor**, behind its flag, for avatars first.
6. **Tailscale optional.** His default route list becomes `rtc:mac, otoji`.
   The tailnet URL remains only if he keeps it.

**Lianki flags** (positive names; owner audience, ON for him when shipped):

| flag | on means |
| --- | --- |
| `voiceprint.otoji` | Lianki uses the otoji verifier and storage |
| `voiceprint.browser-embed` | the page computes embeddings with `@otoji/voiceprint-web` |
| `voiceprint.account-clusters` | clusters are kept in the account's otoji DO, not just in memory |
| `voiceprint.public` | accounts without `dev` may enrol (default off: biometric, like recordings) |

otoji has no flag system. Its switches are Worker vars, and Lianki's flags
decide whether Lianki calls otoji at all.

**Lianki config keys** (`lib/config.ts`, defaults only):

| key | default | note |
| --- | --- | --- |
| `voiceprint.extractor` | `mac` | add `browser`, `otoji` |
| `voiceprint.signers` | `["mac","otoji"]` | race order for a signed tag |
| `voiceprint.uploadMode` | `when-needed` | `device` / `when-needed` / `always` |
| `voiceprint.otojiUrl` | `https://otoji.org/voice` | |
| `voice.printDailyMax` | 2000 | verified utterances per account per UTC day |

**otoji config** (Worker vars, served at `/voice/config`): the bands, the
household margins, `clusterSame` 0.30, `clusterMax` 8,
`clusterForgetDays` 30, `printUnusedDays` 1095, `containerIdleS` 300, and
the browser model URL and hash.

**Secrets.** In otoji: `OTOJI_SPEAKER_KEY`, `OTOJI_VOICEPRINT_KEK`, and the
service token for `/api/voice/usage`. In Lianki: `LIANKI_OTOJI_KEY` (signs
session tickets; otoji gets its public half) and `STT_SPEAKER_PUBS`. Each is
set only after his tap card.

## Cost

List prices, read 2026-11-19
([Containers pricing](https://developers.cloudflare.com/containers/pricing/)):

- vCPU: $0.000020 / s, 375 vCPU-min free per month.
- Memory: $0.0000025 / GiB-s, 25 GiB-h free.
- Disk: $0.00000007 / GB-s, 200 GB-h free.
- Billed per 10 ms while running; sleeping costs nothing.
- Workers Paid: $5 / month for otoji's Cloudflare account (none extra if it
  shares Lianki's).

| item | assumption | per month |
| --- | --- | --- |
| otoji container `standard-1` (4 GiB) | mic on 4 h/day → 480 GiB-h, minus 25 free | ≈ **$4.10** |
| (embeddings only, `basic` 1 GiB) | the same hours, 120 − 25 GiB-h | ≈ $0.86 |
| container CPU | ~0.1 vCPU-s per 5 s utterance, 2,000 / day | 100 vCPU-min, **free tier** |
| browser extractor | model ~8 MB + runtime ~3 MB from R2, once per device | **~$0** (R2 egress free) |
| DO storage | ~16 KB print, ~1 KB per cluster | **~$0** |
| TURN fallback for (d) | Cloudflare Realtime, a few % of sessions | cents |

One container serves every account (it is stateless), so cost grows with
hours of mic in use, not with users. It is booked in Lianki as
`speech.voiceprint` ([payments.md](payments.md)), free to users for now.

## Milestones, by repo (agent hours)

**Lianki** (consumer):

| # | what | agent h |
| --- | --- | --- |
| L1 | hub key ring (`kid` mac / otoji), `trust` and `advisory` on stored tags (M1, in progress) | 3–5 |
| L2 | `voice:print` scope, `/api/otoji/voice-session` ticket, `LIANKI_OTOJI_KEY` | 3–5 |
| L3 | `/api/voice/usage`: credits booking + `voice.printDailyMax` (like mic polish) | 3–5 |
| L4 | the panel and mic path talk to otoji; route race `rtc:mac, otoji`; A/B devLog | 6–10 |
| L5 | `@otoji/voiceprint-web` in the mic path; avatars from `device` tags | 4–6 |
| L6 | consent screen (otoji text, i18n with context, 16 locales), export, delete-all-voices, account deletion → otoji | 6–10 |
| L7 | one-time move of D1 `voiceprint` rows to otoji, then their deletion (tap card) | 2–4 |

Lianki total: **27–45 h**.

**otoji** (the service):

| # | what | agent h |
| --- | --- | --- |
| O1 | `VoiceAccount` DO: sealing, prints / clusters / household / consent / jti, Lianki ticket check, export / delete, retention alarm | 8–12 |
| O2 | container image (CAM++ + SenseVoice), `/voice/verify` WS, decisions, `OTOJI_SPEAKER_KEY` signing, usage booking | 10–16 |
| O3 | `@otoji/voiceprint-web`: spike on his iPhone (size, latency, int8 score shift), then the package and versioned model on R2 | 8–14 |
| O4 | `/voice/config` and `/voice/consent`; the Mac reads the bands from it | 2–4 |

otoji total: **28–46 h**.

**Order.** L1 runs now. O1 needs L2. O2 needs O1 and L1. L4 needs O2. O3
can run in parallel at any time, and L5 needs it. L7 comes after O1 and
after his A/B in L4. Then a legal review (the owner), and only then
`voiceprint.public`.

## Defaults (accepted by the owner, 2026-11-19)

1. **The container also decodes text** (SenseVoice), so `otoji` proofs cover
   the words. Without it they cannot back approvals.
2. **The default upload mode for new users is `when-needed`.**
3. **Liveness for voice approvals:** a one-time phrase shown on screen,
   spoken, and checked against the signed text.
4. **A dedicated sealing key**, not one derived from `AUTH_SECRET`. This is
   now `OTOJI_VOICEPRINT_KEK` in otoji.
5. **Unnamed clusters are forgotten after 30 days unheard.** Named and
   household ones stay until deleted.
6. **A household member's own account is never linked** to his cluster of
   her.
7. **The browser model is int8 CAM++** if the shift is ≤ 0.02, otherwise
   fp32 after consent.
8. **The Mac signer stays** (`mac`).
9. **The container region is Cloudflare's choice**, with audio in memory
   only; revisit before `voiceprint.public`.

## Still open (raised by the move to otoji)

- **otoji's Cloudflare account.** Is it the same account as Lianki's (then
  the DO binding and one Workers Paid plan serve both), or a separate one?
  *Default: the same account, a separate Worker.*
- **Where `server.py` / `voiceprint.py` live.** *Default: they stay in
  Lianki's `scripts/local-stt` until O2 ships, then move to otoji as the
  container's code and the Mac node's code, with one source for both.*
- **Hostname.** *Default: `otoji.org/voice/*` on the existing zone, beside
  `/signal`.*

## Sources

- Workers AI model catalogue: https://developers.cloudflare.com/workers-ai/models/ (2026-11-19)
- Containers pricing: https://developers.cloudflare.com/containers/pricing/
- Containers FAQ (cold starts): https://developers.cloudflare.com/containers/faq/
- Cold-start benchmark: https://alchemy.run/blog/2026-07-01-microvm-cold-starts/
- sherpa-onnx (WASM speaker ID): https://github.com/k2-fsa/sherpa-onnx
- otoji signalling Worker: `~/ws/snomiao/otoji` `signal/src/index.ts`
- In this repo: [local-stt.md](local-stt.md), [voice-mode.md](voice-mode.md),
  [recordings.md](recordings.md), [secrets-and-auth.md](secrets-and-auth.md),
  [payments.md](payments.md), `lib/speaker-proof.ts`; the mic polish API
  (`docs/mic-polish-api.md`, PR #1001)

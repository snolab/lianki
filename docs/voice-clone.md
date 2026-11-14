# Voice clone: the reference in your account

The owner decided on 2026-11-14 (tap card, 02:50 JST, "批准：存到我的账号"):
keep his **voice-clone reference** on his Lianki account, as his voiceprint
is, so speech can be synthesized in his own voice for his account only, from
any Mac. Until now it lived only on the Mac (`~/.config/lianki/voice-ref/`,
read by the Mac-local F5-TTS server `clone-tts-server.py`, port 5212).

This is **audio of a person's voice** kept server-side, where the voiceprint
deliberately keeps features only ([local-stt.md](local-stt.md), "Voiceprint in
your account"). It copies that design and is held to a stricter bar: every
write and every delete takes a fresh Face ID / Touch ID.

Gate: flag [`voice.clone`](https://lianki.com/dev/flags#voice.clone)
(default off, `audience: "owner"`) **and** the `dev` permission on the account
(`lib/permissions.ts`, the grant the voiceprint tickets already need). Either
missing: `/api/my/voice-clone-ref` answers 404. Off D1 or without
`STT_TICKET_KEY`: 503.

## What is kept, and where

| part                        | where                                                   | form                       |
| --------------------------- | ------------------------------------------------------- | -------------------------- |
| the WAV (≤ 30 s)            | R2 `lianki-blobs`, key `voice-clone-ref/<user id>/<rev>` | AES-256-GCM sealed bytes   |
| its transcript              | D1 `voice_clone_ref.text_sealed`                        | AES-256-GCM sealed text    |
| duration, sample rate, size, created, updated | D1 `voice_clone_ref`                  | clear                      |

One row per account (`user_id` primary key; `db/migrations/0074_voice_clone_ref.sql`).
`rev` is random per upload: a replace writes the new object first, points the
row at it, then deletes the old object, so a failed write never leaves the
row pointing at nothing.

**Why R2 for the audio.** A 30 s reference is about 1.44 MB; sealed and
base64'd as D1 text it is about 1.9 MB, at D1's 2 MB row limit, and every
list or metadata read would drag it along. R2 holds bytes as bytes, the Worker
already binds it (`BLOBS`, `getBlobs()`), and other private per-user files live
there (My Files, book covers). Nothing serves that prefix: only this route
reads it, by the session's own user id.

**Accepted audio, nothing else** (`parseWav`, `CLONE_REF_LIMITS` in
`lib/voice-clone-ref.ts`): RIFF/WAVE, PCM (format 1), 16-bit, mono, 24 kHz,
only `fmt `, `LIST` and `data` chunks, each once, sizes that add up to the
file exactly, 1–30 s, at most 1,500,000 bytes; a transcript of 1–2,000
characters with no control characters but tab and newlines. The PUT body is
exactly `{ticket, text, wav}`; any other key, or any of the above off, is
refused whole. The caps are named constants, not config-store keys: they bound
what the Worker decrypts and holds in memory, so raising one is a reviewed
change.

## Encryption

AES-256-GCM. The key is HKDF-SHA256 from the existing Worker secret
`AUTH_SECRET`, salt `lianki/voice-clone-ref`, info
`lianki/voice-clone-ref/at-rest/v1` (`cloneRefKey`): no new secret, and
neither the voiceprint's key nor the one that seals Google tokens. The AAD is
`voice-clone-ref`, the **user id**, the **kind** (`audio` or `text`) and the
**rev**: a sealed half copied to another account, swapped for the other kind,
or paired with another upload's half does not open. Sealed audio is
`LKC1` + 12-byte IV + ciphertext and tag; the transcript uses the shared
`seal()` format (`v1.<iv>.<ct>`). A D1 export or an R2 listing alone reads
nothing. Rotating `AUTH_SECRET` leaves the reference unreadable (`GET ?audio=1`
says `unreadable: true`); upload it again from the Mac.

## Who can read and write it

- **Own row only.** Every statement is by the session's user id; nothing in a
  request names an account. The session cookie only: an API token reads
  nothing here.
- `GET` → `{ref: null}` or `{ref: {durationMs, sampleRate, bytes, createdAt, updatedAt}}`: metadata, no audio.
- `GET ?audio=1` → the same with `text` and `wav` (standard base64), decrypted, for the session's own account.
- `PUT {ticket, text, wav}` → store or replace; `wav` is the file in standard base64. A body over `MAX_PUT_BODY` is refused (413) before it is parsed.
- Errors are kebab-case codes: `not-found`, `voice-clone-off` (503), `too-large` (413), `bad-body`, `not-mono`, `too-long`, `bad-sample-rate`… (400), `wrong-op`, `no-passkey`, `not-your-ticket`, `expired`, `approval-already-used` (401).
- `DELETE {ticket}` → delete the row and the object (`deleted: 1`, or `0` when there was none).

The ticket is a voiceprint ticket (`lib/voiceprint-ticket.ts`: Ed25519
`STT_TICKET_KEY`, aud `lianki-voiceprint`) for op `clone-ref-put` or
`clone-ref-delete`, device `*`, `uv: true`, the account's `uid`, live 60 s,
minted by `POST /api/dev/voiceprint-ticket` after a WebAuthn assertion with
user verification from one of the account's passkeys. lianki.com spends it
once (`verification`, `voice-clone-ref:<jti>`). Stricter than the voiceprint:

- **No passkey window.** These ops are `FRESH_PASSKEY_OPS`: the ten-minute
  grant never mints them (`step:"grant"` → 403), and their own assertion hands
  out no grant. Each store, replace or delete is its own Face ID / Touch ID.
- A voiceprint ticket (`export`, `delete`, …) does not open these routes, and a
  clone-ref ticket opens no voiceprint route nor any op on the Mac's STT server.

## Uploading from the Mac

```
tap "Save my voice to my account" → passkey → POST /api/dev/voiceprint-ticket
  {op:"clone-ref-put", device:"*", step:"options"} → {options, token}
  {op:"clone-ref-put", device:"*", step:"verify", token, response} → {ticket}
page → the Mac's clone server {op:"clone-ref-export", ticket}   checks the ticket (aud, op, uv, once)
     ← {text, wav}                                             owner.txt, owner.wav as they are
page → PUT /api/my/voice-clone-ref {ticket, text, wav}          the same ticket, spent once more here
```

The page holds the session, so the page does the PUT; the Mac only hands over
its two files to a ticket it has checked. The WAV must already be 24 kHz mono
16-bit PCM, ≤ 30 s (resample on the Mac, never here).

## Deleting it

`DELETE /api/my/voice-clone-ref {ticket}` with a fresh `clone-ref-delete`
ticket deletes the D1 row and the R2 object at once. Turning the flag off does
**not** delete it: it only makes the route 404, so the reference stays sealed
and unread until he deletes it or turns the flag on again. Nothing deletes it
automatically.

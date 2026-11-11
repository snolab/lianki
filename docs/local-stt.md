# Local streaming speech-to-text

The owner's mic can transcribe on his own Mac instead of Workers AI: while he
speaks, the frames stream there and partial text comes back as he talks; the
final text lands the moment the VAD ends the utterance. It is owner-only,
behind a localStorage flag, and any failure falls back to `/api/debug/stt`
(docs/workers-ai.md, "Speech to text") exactly as before.

```
phone (lianki.com, debug chat mic)
  Silero VAD ─ frames (16 kHz int16, 32 ms) ─▶ wss://<mac>.ts.net/lianki-stt  (tailscale serve, tailnet only)
            ◀─ {partial} every 0.1 s of audio ─  scripts/local-stt/server.py
            ─ pre-pad + {end} ─▶                   SenseVoice-Small (sherpa-onnx, CPU)
            ◀─ {final} ~50–190 ms later ─
  on any failure: POST /api/debug/stt (unchanged)
```

**User-facing wording** (owner, 2026-11-11): every string a user can see calls
this server **"Lianki's speech server(s)"** — never "your Mac", "the owner's
computer" or "the local model" (it is one of Lianki's speech servers, and may
move to the cloud). This doc keeps the technical truth. /privacy, "Your voice
and speech-to-text" (`#voice`), states what users are promised: STT runs only
when the user asks; the audio is not stored or logged (here: `server.py`
writes no audio outside opt-in enrolment, the clip sink is the owner's own
session only, `/api/debug/stt` logs sizes and timings only); only what a user
keeps is stored (opt-in enrolment recordings in My Files; voiceprint features
on the speech server and, encrypted, in the account). Keep both true together.

## Turn it on

On the Mac (once):

```bash
uv venv -p 3.12 ~/.cache/lianki-stt/venv
VIRTUAL_ENV=~/.cache/lianki-stt/venv uv pip install sherpa-onnx soundfile numpy opencc-python-reimplemented websockets mlx-whisper onnxruntime cryptography
mkdir -p ~/.cache/lianki-stt/models && cd ~/.cache/lianki-stt/models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
tar xjf sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
```

Run the server (it maps itself into the tailnet and removes the mapping on exit):

```bash
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/server.py --port 5193 --tailnet /lianki-stt
```

To keep it running after a session (or after a reboot), from a checkout of
`main` (any worktree), in two terminals or as background jobs:

```bash
# the STT server: tailnet path /lianki-stt (production lianki.com pages use only this)
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/server.py \
  --port 5193 --tailnet /lianki-stt --origin https://<mac>.ts.net \
  >> ~/.cache/lianki-stt/logs/server.log 2>&1
# only to preview widget changes before they ship (docs/dev-debug-widget.md):
bun scripts/dev/debug-widget-server.ts --port 5194 --tailnet /lianki-widget-stt
```

To keep the STT server up across logouts, crashes and reboots, run it under
the Mac's process supervisor, oxmgr (not set up yet; the owner decides).
From the main checkout, so it serves what is on `main`:

```bash
cd ~/ws/snolab/lianki/tree/main
oxmgr start --name lianki-stt --restart always \
  --cwd "$PWD" \
  --health-cmd "curl -fsS http://127.0.0.1:5193/health" --health-interval 60 \
  "$HOME/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/server.py --port 5193 --tailnet /lianki-stt --origin https://<mac>.ts.net"
oxmgr startup --system launchd   # prints the launchd step that starts the oxmgr daemon at login
oxmgr logs lianki-stt            # connections, finals (length and decode ms, never text), refused handshakes
oxmgr restart lianki-stt         # after pulling a change to scripts/local-stt
```

`--tailnet` maps `/lianki-stt` with `tailscale serve --bg` on start. The
mapping survives a restart, so a crash loop never leaves the page pointing
nowhere for long; the dot just turns grey and the mic uses the cloud
meanwhile. To take it down for good: `oxmgr delete lianki-stt` and
`tailscale serve --set-path /lianki-stt off`.

`--origin` adds the tailnet origin for the widget harness; lianki.com and the
owner's preview build (preview.lianki.com, docs/dev-whole-page.md) are always
allowed. The preview is another origin, so its page needs its own
`lk:agent-local-stt` (localStorage is per origin). Once this is on main, production pages need only the STT
server and the flag below: the widget code ships with the app. If the server
is not running, the dot is grey and the mic uses the cloud as before.

On the owner's page:

```js
localStorage.setItem("lk:agent-local-stt", "wss://<mac>.ts.net/lianki-stt");
// with the tunnel as a second route (see "Off the tailnet" below):
localStorage.setItem("lk:agent-local-stt", "wss://<mac>.ts.net/lianki-stt wss://stt.lianki.com");
location.reload();
// off again: localStorage.setItem("lk:agent-local-stt", "off")
// (removing both keys puts the owner's page back on the default below)
```

**On by default for the owner** (2026-11-04, after a PC's lianki.com never
had the flag and stayed on the cloud): with nothing stored, the owner's page
(the hub's verified owner session, DebugEval `owner`; never a friend or
another user) uses `OWNER_DEFAULT_LOCAL_STT`, the tailnet URL then
`wss://stt.lianki.com`, through the same race. A stored value always wins;
`localStorage.setItem("lk:agent-local-stt", "off")` turns it off on that
origin, default included (`localSttRoute`, `local-stt.ts`). The devLog says
which: `local-stt {state:"route", source:"stored"|"owner-default"|"off"}`,
then `{state:"ready", via:…}` for the winner; the mic's dot is green for local.

It is read with `getKey` (storage-keys.ts): `lk:agent-local-stt` first, then
the legacy `lk:debug-local-stt`. When both are set and differ, the one
written since the last read wins and is copied to the other name (getKey
keeps the pair it last saw in `lk:agent-seen`). Before this, a stale value
under the new name silently won over a fresh one under the old, which is how
the first preview loaded the wrong widget and how a phone kept an old STT
URL. Two names that already differed before any read still give the new
name (logged once in the console); set the `lk:agent-*` name to be sure.

While the mic is on, a dot at the button's top corner says where speech goes:
green, the local model (`ready`); amber and pulsing, connecting; grey, not
reachable, so the cloud route (strings in zh/ja/en, `localSttStrings` in
`ui-strings.ts`). It is the socket's state (`LocalStt.state()`, via the mic
session's `view.local`).

The flag is read only on owner pages (`friend ? undefined : …` in
`DebugChat.tsx`, as for the clip sink), and only a `wss:` URL, or `ws:` on
localhost, is taken (`localSttFrom`). The server accepts only lianki.com (and
localhost) origins. Its main port is reachable only from the tailnet; the
tunnel listener (next section) only with a ticket.

/vibe ([vibe.md](vibe.md)) uses this server with its own mic and its own socket:
tailnet only (never the tunnel below), no hello, no filter, no cloud fallback, no
clip sink.

## Off the tailnet: wss://stt.lianki.com

A second route for the phone when Tailscale is off, approved by the owner on
2026-10-31 (18:18 JST). Tailscale stays the first route (end to end, often a
little faster) and the cloud (`/api/debug/stt`) the last.

```
page ─ POST /api/dev/stt-ticket (owner session) ─▶ lianki.com Worker: signs with STT_TICKET_KEY (Ed25519 private)
page ─ wss://stt.lianki.com, Sec-WebSocket-Protocol: lianki-stt, <ticket> ─▶ Cloudflare edge (rate limit)
     ─▶ named tunnel "lianki-stt" (cloudflared on the Mac, oxmgr lianki-stt-tunnel)
     ─▶ 127.0.0.1:5188  server.py tunnel listener: Origin, ≤ 2 sockets, ticket — else 403/503/401, no upgrade
```

**The ticket** (`lib/stt-ticket.ts`, verified by `scripts/local-stt/ticket.py`):
`{aud:"lianki-stt", jti, iat, exp}`, 60 s (5 s of clock skew allowed), good
once (the server remembers each jti until it expires), signed with Ed25519.
The private key is the Worker secret `STT_TICKET_KEY`; the Mac holds only the
public key, `~/.config/lianki-stt/ticket.pub`. No `AUTH_SECRET` or other
shared secret is involved. The ticket goes in `Sec-WebSocket-Protocol` beside
`lianki-stt` (browsers cannot set other headers on a WebSocket), never in the
URL, so it is in no access log. The page sends a ticket only to
`TICKET_HOSTS` (`stt.lianki.com`), never to another host a stored value names.

**The listener** is a second port of the same server process, on 127.0.0.1
only, and the tunnel's ingress points at nothing else (`http_status:404` for
any other hostname). It checks, in `process_request`, before any upgrade:
Origin is lianki.com (403), fewer than 2 sockets open (503), a ticket offered
(401), and the ticket valid (401: bad signature, wrong aud, expired, bad
lifetime, replayed). It has no `/health`. The per-utterance limit (`MAX_S`)
and the 4 MB frame limit apply as on the main port. Refusals are logged with
the reason, never the ticket. Without the public key file the listener does
not start at all (fail closed). If it cannot start (the port taken, say), the
server logs `public listener off: cannot listen …` and carries on: the
tunnel listener is optional and never takes the tailnet one down. Once its
ticket store holds `MAX_SEEN` (1000) live jtis it answers 503, and expired
jtis are pruned before that check, so a burst clears itself within a minute.

It is switched on by `--public-port`/`--ticket-pubkey`, or by
`~/.config/lianki-stt/public.json` (`{"port": 5188, "pubkey": "<path>"}`),
which is what `tunnel.sh` writes. The oxmgr entry of `lianki-stt` therefore
never changes: its command, health check and other flags stay as they are,
and turning the tunnel on or off is that file plus `oxmgr restart`.
`--public-config ""` ignores the file (the tests use it).

Both `public.json` and the ticket key must be regular files owned by the
user running the server and writable by no one else (not group- or
world-writable), and neither may be a symlink (`file_problem` in
`ticket.py`). Otherwise the server logs `public listener off: <file> is a
symlink` (or `is not owned by this user`, `is group- or world-writable`) and
runs the tailnet listener only. `tunnel.sh` writes `public.json` as a fresh
0600 file.

**No Cloudflare Access** in front: tickets only, as the evaluation
recommended. Access service tokens need request headers a browser WebSocket
cannot send, and an Access login cookie expires silently into a grey dot.

**The race** (`createLocalStt`, `local-stt.ts`): with several URLs in
`lk:agent-local-stt` (space or comma separated), the first opens at once and
each next one `RACE_STAGGER_MS` (150 ms) later, or at once when the one
before it has already failed (Tailscale off). The ticket is asked for when
the race starts, so it is there by 150 ms. The first socket to say `ready` is
used and the others are closed; if all fail, or none is ready within
`CONNECT_TIMEOUT_MS`, the dot is grey and the utterance goes to the cloud. A
new race (and a new ticket) starts when the socket drops while the mic is
on, when the page is visible again, when it comes back online, and on the
next utterance ("Fallback"). Nothing polls. The devLog says which route won: `local-stt
{state:"ready", via:"stt.lianki.com"}`, and `lost-race {via, why}` for the
others.

**Trade-offs** (the evaluation, 2026-10-31): TLS ends at Cloudflare's edge,
so Cloudflare sees the audio in clear (Tailscale is WireGuard end to end).
The hostname can be found by DNS brute force, so nothing relies on it being
hidden. The attack surface is Python `websockets` and the sherpa-onnx decode
on the owner's main Mac, behind the ticket. Latency over the tunnel is about
the same as Tailscale's DERP relay (+10–30 ms RTT, estimated).

### Setting it up

1. Once, in a browser: `cloudflared tunnel login` (pick the lianki.com zone).
   It writes `~/.cloudflared/cert.pem`. `cloudflared` itself lives in
   `~/.local/bin` (the `cloudflared-darwin-arm64.tgz` release).
2. Once, with the owner's OK (a production secret):
   `bun scripts/local-stt/ticket-key.ts | bunx wrangler secret put STT_TICKET_KEY`.
   It writes the public key to `~/.config/lianki-stt/ticket.pub` and the
   private key only into the pipe (it refuses a terminal). Running it again
   rotates the pair.
3. From the main checkout, after this is on `main`: `scripts/local-stt/tunnel.sh up`.
   It creates the named tunnel `lianki-stt` (separate from
   `lianki-userscript-dev` / dev.lianki.com), writes `~/.cloudflared/lianki-stt.yml`,
   routes `stt.lianki.com` to it, writes `public.json` (port 5188, the key
   at `STT_TICKET_PUB`, default `~/.config/lianki-stt/ticket.pub`), restarts
   oxmgr `lianki-stt` and checks it: its "listening" line in its own log
   within 90 s, "public listener on" among the lines before it, and
   `/health` on the tailnet port. If any check fails it puts `public.json`
   back as it was, restarts again, and stops before starting the connector.
   Only then does it run cloudflared as oxmgr `lianki-stt-tunnel`.
   The credentials file `~/.cloudflared/<uuid>.json`, the config and the
   cert are mode 0600 and live only on the Mac (never in the repo).
4. The rate-limit rule (Free plan's one: 10 handshakes per 10 s per IP, then
   10 s blocked): `CLOUDFLARE_API_TOKEN=… bun scripts/ops/stt-edge.ts`
   (`tunnel.sh up` runs it when the token is set). The token needs Zone · DNS
   · Edit and Zone · Zone WAF · Edit on lianki.com; wrangler's login has
   neither.
5. `scripts/local-stt/tunnel.sh status`: `https://stt.lianki.com/` must
   answer **401** (up, and refusing without a ticket).

### Rollback

```bash
CLOUDFLARE_API_TOKEN=… scripts/local-stt/tunnel.sh down
```

Stops and deletes oxmgr `lianki-stt-tunnel`, removes `public.json` and
restarts `lianki-stt` (its oxmgr entry untouched; the tailnet route keeps
working, and is checked the same way), deletes the tunnel and its
credentials file and config, and with the token deletes the `stt.lianki.com`
record (only if it points at a tunnel) and the rate-limit rule. Without the
token it does everything else, says the record is left, and exits 1; with the
tunnel gone that record reaches nothing. `DRY_RUN=1` prints the commands
instead. Idempotent; tested against stubs in `unit/stt-tunnel.test.ts`.
Turning the route off on the page alone: set `lk:agent-local-stt` back to the
tailnet URL.

## Which engine, and why

Measured on 2026-10-30 on the M5 Max, with the owner's 12 saved clips
(`~/lianki-voice-clips`, 16 kHz WAV from the iPhone; 10 zh, 2 en). Workers
AI's column is the transcript it gave at the time (turbo, no `?hint=`).
Times are whole-clip decode, cold (the first decode after loading) / warm
(best of 3); RTF = warm decode ÷ audio length.

| clip   | s    | Workers AI (today)                                                                                                                                                | sensevoice                                                                                                                                                                                                | mlx-whisper                                                                                                                                                                                                                                                         |
| ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 273Z-0 | 14.0 | 內容有腰丸、麥克風、緊湊消息區、聚焦彩朗讀、代碼都集中到移動目錄。預計半個Agent 小時上線。授權丟失的問題我也在確認是否已包含。                                    | 内容有药丸麦克风紧凑消息区聚焦才朗读代码都集中到移动目录，预计半个agent小时上线，授权丢失的问题，我也在确认是否已包含。 <br>`zh` 137/122 ms, RTF 0.009                                                    | 内容有腰丸、麦克风、紧凑消息区、聚焦采朗读、代码都集中到移动目录。预计半个Agent小时上线。授权丢失的问题我也在确认是否已包含。 <br>`zh` 1190/320 ms, RTF 0.023                                                                                                       |
| 646Z-1 | 6.6  | 表天授權已修好,切應用不再重溫,你還看到的體驗。                                                                                                                    | 表天授权已修好，且应用不再重问。你还看到的。 <br>`zh` 69/63 ms, RTF 0.010                                                                                                                                 | 表天授权已修好,切应用不再重温。你还看到的挺。 <br>`zh` 231/229 ms, RTF 0.035                                                                                                                                                                                        |
| 945Z-2 | 5.5  | 現在用的原模型是哪個?                                                                                                                                             | 现在用的云模型是哪个？ <br>`zh` 52/51 ms, RTF 0.009                                                                                                                                                       | 现在用的原模型是哪个? <br>`zh` 206/203 ms, RTF 0.037                                                                                                                                                                                                                |
| 062Z-3 | 13.2 | 現在用的語音識別模型是哪個?                                                                                                                                       | 现在用的语音识别模型是哪个。 <br>`zh` 112/111 ms, RTF 0.008                                                                                                                                               | 现在用的语音识别模型是哪个? <br>`zh` 215/212 ms, RTF 0.016                                                                                                                                                                                                          |
| 722Z-4 | 4.9  | 他是內置知識多語言的嗎?                                                                                                                                           | 它是内置支持多语言的吗？ <br>`zh` 52/50 ms, RTF 0.010                                                                                                                                                     | 他是内置知识多语言的吗? <br>`zh` 210/209 ms, RTF 0.043                                                                                                                                                                                                              |
| 347Z-5 | 21.2 | 語音識別模型是Whisper Large V3 Turbo 跑在Cloud Player上自動識別語言是Whisper本身就是多語言模型支持約100種語言會自動判斷說的是哪種中日音都測過沒問題一句話裡中途壞 | 语音识别模型是whisper largege recent tubo，好在pug flare上自动识别语言是whisper本身就是多语言模型支持约100种语言会自动判断说的是哪种。中日英都测过没问题。一句话里中途会。 <br>`zh` 196/187 ms, RTF 0.009 | 语音识别模型是Whisper Large V3 Turbo, 跑在Cloud Player上,自动识别语言。是,Whisper本身就是多语言模型,支持约100种语言,会自动判断说的是哪种。中日音都测过,没问题。一句话里中途坏。 <br>`zh` 351/332 ms, RTF 0.016                                                      |
| 446Z-6 | 12.6 | 這個麥克風按鈕應該也要遵循自動加標點並且自動上屏的原則。                                                                                                          | 这个麦克风按钮应该也要遵循自动加标点，并且自动上屏的原则。 <br>`zh` 109/107 ms, RTF 0.009                                                                                                                 | 这个麦克风按钮应该也要遵循自动加标点并且自动上屏的原则。 <br>`zh` 246/244 ms, RTF 0.019                                                                                                                                                                             |
| 379Z-7 | 3.5  | シェイカーマイカフォン。                                                                                                                                          | 切个麦克风。 <br>`zh` 38/36 ms, RTF 0.011                                                                                                                                                                 | então割 icon nothing Lightful Watch your coffee con card for game name it's over like aliction we need you La never mind lock on my coffee with each other York City Put it on my coffee with each other Take your microphone. ×20 <br>`is` 2464/2410 ms, RTF 0.691 |
| 230Z-8 | 9.7  | 銀外、麦克風也要自動加標點,並自動上屏。我保證識別結果一定帶標點,沒帶的話不。                                                                                      | 赢外麦克风也要自动加标点并自动上屏。我保证识别结果一定带标点，没带的话不。 <br>`zh` 98/92 ms, RTF 0.010                                                                                                   | 银货﹑麦克风也要自动加标点,并自动上屏。我保证识别结果一定带标点,没带的话不。 <br>`zh` 262/258 ms, RTF 0.027                                                                                                                                                         |
| 649Z-9 | 6.3  | 他現在還在瘋狂的問我要授權。                                                                                                                                      | 他现在还在疯狂的问我要授权。 <br>`zh` 63/62 ms, RTF 0.010                                                                                                                                                 | 他现在还在疯狂的问我要授权。 <br>`zh` 219/219 ms, RTF 0.035                                                                                                                                                                                                         |
| 97Z-10 | 9.9  | 这个什么时候呢我先停掉不必要的带马连接别再谈授权需兽权的修复我提到最优秀                                                                                          | 这个什么时候能修接授权授权的修复我提到最优。 <br>`zh` 93/93 ms, RTF 0.009                                                                                                                                 | 这个什么时候呢Ｂ。 <br>`zh` 209/212 ms, RTF 0.021                                                                                                                                                                                                                   |
| 43Z-11 | 3.1  | How's the name?                                                                                                                                                   | Hose name. <br>`en` 37/35 ms, RTF 0.011                                                                                                                                                                   | 竹 Garne <br>`en` 790/795 ms, RTF 0.256                                                                                                                                                                                                                             |

- **sensevoice**: load 430 ms; warm mean 84 ms, max 187 ms; mean RTF 0.010
- **mlx-whisper**: load 793 ms; warm mean 470 ms, max 2410 ms; mean RTF 0.102

**SenseVoice-Small** is the engine:

- **Streaming.** It is non-autoregressive: a decode costs ~9 ms per second of
  audio on the CPU (RTF ≈ 0.009), so re-decoding the whole utterance every
  0.4 s is cheap even at 30 s. That gives true growing partials with no
  chunk seams: the final is the same decode over the whole utterance, so
  streaming costs no accuracy. Whisper is autoregressive (~200–330 ms per
  decode on MLX, whatever the length, and seconds when it hallucinates), so it
  would need 2–3 s windows and the overlap merge the route path uses.
- **Simplified Chinese with punctuation**, always (`use_itn`; OpenCC t2s for
  zh/yue). Workers AI turbo gave traditional on 9 of 10 zh clips.
- **No hallucinations on short clips.** On the 3.5 s clip Workers AI heard
  「シェイカーマイカフォン。」 and mlx-whisper a paragraph of mixed-language
  nonsense; SenseVoice heard 「切个麦克风。」 (said: 这个麦克风). On the 3 s English clip
  mlx-whisper also invented a sentence.
- **Where Whisper is better**: English terms inside Chinese (「Whisper Large V3
  Turbo」 vs SenseVoice's 「whisper largege recent tubo」), and the long
  clip's sentence punctuation; and on clip 10, a mumbled one, SenseVoice
  dropped a phrase (「我先停掉不必要的…连接别再谈」) that Workers AI's fallback
  Whisper kept. English: the 3 s clip is only right on Workers AI ("How's
  the name?" vs "Hose name."). The A/B is on 12 clips; more of the owner's
  clips (the sink keeps collecting) will tell whether these matter. Engines
  are swappable (`--engine mlx-whisper`), and the protocol does not change.

Other candidates not taken: the 2025-09-09 SenseVoice int8 export (no
punctuation, detected every clip as Cantonese); sherpa-onnx's streaming
Paraformer (zh/en only — no Japanese).

## Latency

Streaming the clips at real-time pace over the tailnet (`stream-clip.ts`;
Mac to itself through `tailscale serve`, so no radio hop):

| clip   | s    | partials | first partial | end → final |
| ------ | ---- | -------- | ------------- | ----------- |
| 273Z-0 | 14.0 | 29       | 438 ms        | 127 ms      |
| 646Z-1 | 6.6  | 11       | 413 ms        | 68 ms       |
| 945Z-2 | 5.5  | 10       | 422 ms        | 59 ms       |
| 062Z-3 | 13.2 | 18       | 439 ms        | 116 ms      |
| 722Z-4 | 4.9  | 8        | 421 ms        | 51 ms       |
| 347Z-5 | 21.2 | 42       | 429 ms        | 187 ms      |
| 446Z-6 | 12.6 | 23       | 423 ms        | 112 ms      |
| 379Z-7 | 3.5  | 5        | 441 ms        | 44 ms       |
| 230Z-8 | 9.7  | 21       | 432 ms        | 120 ms      |
| 649Z-9 | 6.3  | 10       | 420 ms        | 67 ms       |
| 97Z-10 | 9.9  | 22       | 438 ms        | 95 ms       |
| 43Z-11 | 3.1  | 4        | 429 ms        | 45 ms       |

- **First partial ~0.42–0.44 s** after the first frame (0.3 s of audio, then
  the 0.4 s step), whatever the length. (That table is the old step; since
  "Rolling partials" below it is 113–133 ms.)
- **End → final 44–187 ms**, growing ~9 ms per second of speech. The route
  path today is an upload of the whole WAV plus Workers AI turbo, the
  documented example being 812 ms, before any network from the phone.
- Not counted in either: the VAD's own hangover. vad-web 0.0.30 ends an
  utterance after `redemptionMs` 1400 ms of silence (not overridden in
  `MicButton.tsx`), the energy fallback after 700 ms. On the route path that
  stays. **While streaming, the mic ends the utterance itself**: after
  `ENDPOINT_MS` (600 ms) of Silero probability under a threshold, it calls
  the VAD's `flush()`, which hands over the audio at once (`mic.ts`,
  `endpointThreshold`; devLog `stt-endpoint {floor}`). That is ~0.8 s off
  every utterance, the largest single cut. Partials are already on screen, so
  a slightly early end costs little; speech that resumes starts a new
  utterance, joined in order.
- The threshold adapts to noise: the floor is an EMA (`FLOOR_ALPHA` 0.05 per
  32 ms frame, ~1 s) of Silero's probability between utterances, and the
  threshold is floor + 0.25, kept within 0.35–0.8. In a quiet room it is
  0.35; with steady noise holding the probability around 0.45, it rises to
  0.7, so the noise does not hold an utterance open. Speech start is still
  vad-web's own (0.5); noise that starts an utterance gives a short or empty
  final, which the hallucination guard and the empty-text rule drop.

First real use on the owner's iPhone (2026-10-30, tailnet over his network):
three finals local, decode 35–109 ms on the Mac, no fallback.
「我们现在用的是流失传输吗？」 (流式 → 流失, a homophone) is left to the
polish-edit (#313), which sees local finals exactly like route ones: they
come through the same `upload()` → `onText` path. On his two clips from that
morning SenseVoice heard 「开思考模式」 where Workers AI wrote 「開十四巢模式」.

The phone's own numbers (radio, tailnet relay) come from the devLog:
`local-stt-final {decodeMs, endToFinalMs, firstPartialMs, durationMs}` per
utterance, `local-stt-fallback {error}` when it fell back. They need the owner
talking into the phone; they are not measured here.

## Rolling partials

The owner's floor (2026-11-11): **the next feedback within 0.2 s** of speech, a
wrong word being better than none. 0.2 s is the worst acceptable, not the goal.

- **Step**: a partial every `--partial-step` 0.1 s of new audio, from
  `--partial-min` 0.1 s (were 0.4 s and 0.3 s). First partial 112–123 ms
  after the first frame (was ~430 ms).
- **What still misses the floor**: the longest gap between partials while the
  speaker talks ("in speech": frames louder than a quarter of the clip's
  90th-percentile RMS) is 134–1476 ms on the 12 clips. The decode is not the
  limit (a pass is 30–240 ms): SenseVoice's CTC holds back a syllable it is
  not sure of, so the text does not change for a few passes. The chat bar's
  caret (`MicCaret.tsx`, `voice-level.ts`) moves with the voice every 32 ms
  frame, so speaking always shows within the floor.
- `stream-clip.ts` prints `first`, `max gap (in speech …)` and end → final per
  clip; the in-speech gap is the acceptance number, not the mean.

**Tried, off by default** (each measured back to back on the same 12 clips;
the machine's load was not quiet, 4–45):

- **Rolling decode** (`LIANKI_STT_ROLLING=1`, `rolling.py`, tests
  `test_rolling.py`): each pass decodes only the unsettled tail, so its cost
  stays flat. A stretch settles at a punctuation mark or a pause (≥ 0.3 s
  between tokens) two passes agree on, 0.6 s before the end of the heard
  audio, and each pass also decodes 2 s of settled audio before the tail as
  context. What went wrong on the way: settling between any two tokens
  repeated syllables (「持っ持っ」, live for a few hours as #896) and split
  English words; a tail decoded with no context invented words (「Yeah」
  「Okay」); punctuation alone let the tail grow. With context the text is
  clean but for a dropped character at a seam, and the in-speech gap is the
  same as the whole decode's (134–1323 ms): at these lengths the cost was
  never the limit. Worth it for long utterances only.
- **Early guesses** (`LIANKI_STT_BLANK_PENALTY=6`): partials run the same
  model in full precision through onnxruntime (`LangPicker.guess`) with the
  CTC blank's logit lowered, so an unsure syllable shows its best guess;
  punctuation gets no push (it scattered commas). In-speech gap 197–349 ms vs
  134–653 ms without, but end → final 219–606 ms vs 56–327 ms (the two
  runtimes contend for the CPU).

## Language switch

The owner's design (2026-11-11): keep the last 30 s, notice when the speaker
changes language mid-utterance, re-read the missed part with the right
language, and backfill it. The whole-utterance decode reads one language: on
a Chinese then Japanese clip (the model's own `test_wavs`, joined) it keeps
the Japanese and leaves the Chinese as 「开饭9」.

**On by default** (`LIANKI_STT_SWITCH=0` turns it off; `switch.py`, tests
`test_switch.py`). The cuts are where **Silero hears silence**, not CTC gaps,
so every stretch holds speech and silence is never read on its own (the
rolling decode's stretches read it as 「Yeah」「嗯」):

- **While he speaks**: Silero (`silero_vad.onnx`, min silence 0.25 s) hears
  each chunk as it comes (`Tracker.feed`, ~3 ms per audio second), and each
  speech run's language is picked from its first 1.5 s as soon as the run is
  that long, on the language picker's side pool (`LangPicker.lang_probs`: the
  model's language frame, softmax over zh/en/ja/ko/yue, ~80 ms). The page's
  pre-pad arrives with `end`; it only shifts the positions (`prepend`), the
  picks stand.
- **At the final**: the whole decode runs as before; beside it, the runs are
  planned (`plan`): a run is trusted for its language when it is ≥ 1 s and
  p ≥ 0.8; the rest take the language before them. **English never starts a
  switch** while another language is trusted (`CARRIED`): SenseVoice writes
  English terms inside Chinese or Japanese text, and reading them alone
  mangled them (「whisper large v3 turbo」 on the owner's clips). yue counts
  as zh. Two or more stretches: each is decoded on its own (auto, full
  precision; forced to its language when auto hears another, not English),
  joined, and the final carries `langs`. One stretch: the whole decode stands.
- **Measured** (2026-11-11, load 9–13, `stream-clip.ts`, on vs off): zh+ja
  「开饭时间早上9点至下午5点。うちの中学は…」 (off: 「开饭9 うちの…」);
  ja+ko keeps both (off: also both); en+zh: no switch (English), the whole
  decode stands. End → final on the 12 owner clips 55–313 ms on vs 55–367 ms
  off (noise); the switched ones 135–255 ms vs 121–146 ms. **0 of 208**
  owner clips (≥ 1 s) were split.
- Guests on the peer listener get it too (it reads only their own audio).

The rolling decode's own language spans (`LIANKI_STT_LANG_SPANS`) are gone.

## Protocol

One socket per page; utterances one after another (`server.py` docstring):

| from   | message                                                             | meaning                                                                                                                                      |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| client | `{"t":"begin","id":N}`                                              | a new utterance                                                                                                                              |
| client | binary `0x01` + int16le PCM                                         | frames of the current one, as heard                                                                                                          |
| client | binary `0x02` + int16le PCM                                         | the VAD's pre-pad: audio before the first frame                                                                                              |
| client | `{"t":"end","id":N}`                                                | decode it now                                                                                                                                |
| client | `{"t":"cancel","id":N}`                                             | drop it (misfire, the agent speaking)                                                                                                        |
| server | `{"t":"ready","engine","model"}`                                    | on connect                                                                                                                                   |
| server | `{"t":"partial","id","text","audioMs"}`                             | every 0.1 s of new audio (`--partial-step`), when the text changed                                                                           |
| server | `{"t":"final","id","text","lang","model","ms","audioMs","signals"}` | the whole utterance decoded; `signals`: `{decoder, logprob?}` for the page's silence guard ([workers-ai.md](workers-ai.md), "Silence guard") |
| server | `{"t":"error","id","error"}`                                        | then the page falls back                                                                                                                     |

`GET /health` on the same port answers `{ok, engine, model}`.

A final also carries `langAuto` when the short-utterance pick below replaced
the auto-detected language (`lang` is then the forced one). The server log
line says `lang en->ja`, never the text.

The voiceprint adds these (next section):

| from   | message                                                                                           | meaning                                                                  |
| ------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| client | `{"t":"hello","device":"iphone"}`                                                                 | after `ready`: score this socket's finals against that print             |
| client | `{"t":"begin","id":N,"enrol":"<enrolment id>"}`                                                   | an enrolment sentence: not scored, its final carries `enrol`             |
| client | `{"t":"end","id":N,"textFrom":S}`                                                                 | text from sample S on (after "Linky"); the speaker hears it all          |
| client | `{"t":"enrol","op":"start","rid","device","ticket","keepAudio":false}`                            | open an enrolment: needs an `enrol` ticket for that device (passkey)     |
| client | `{"t":"enrol","op":"commit"\|"cancel","rid","enrolment"}`                                         | save it (10 sentences at least), or drop it                              |
| client | `{"t":"voiceprint","op":"status"\|"delete","rid","ticket"[,"device":D\|"*"]}`                     | what is enrolled (status ticket); delete the print only (passkey ticket) |
| client | `{"t":"voiceprint","op":"delete-audio","rid","device":D\|"*","ticket"}`                           | delete only the kept enrolment recordings (its own passkey ticket)       |
| server | status answer + `"bands":{model:{minSpeechS,minSnrDb,bands:[{minS,me,other}]}}`, `"recordings":n` | the decision's thresholds (the test shows them); kept recordings         |
| server | delete answer + `"recordings":n`                                                                  | the kept recordings left on the Mac (the panel then asks)                |
| client | `{"t":"voiceprint","op":"export","rid","device":D\|"*","ticket"}`                                 | the features, for his account (passkey ticket): `prints` back            |
| client | `{"t":"voiceprint","op":"restore","rid","device":D\|"*","prints":[…],"ticket"}`                   | write prints read from his account (passkey ticket)                      |
| client | `{"t":"filter","on":bool}`                                                                        | the voiceprint filter on this socket (off until said)                    |
| server | `ready` + `"speaker":{"models":["campp"]}`                                                        | the check is on                                                          |
| server | `final` + `"speaker":{score,decision,model,device,speechS,snrDb[,reason]}`                        | the check on that final                                                  |
| server | `final` + `"speakerProof":"<payload>.<sig>"`                                                      | the Mac's signature over that tag and the final's text                   |
| server | `final` + `"enrol":{ok,n[,reason]}`                                                               | an enrolment sentence kept (or why not)                                  |
| server | `{"t":"enrol"\|"voiceprint","rid","ok"[,"error"],…}`                                              | the answer to a request                                                  |
| server | `final` + `"filtered":{reason,score}`, text empty                                                 | the filter stopped it: nothing decoded, no proof                         |
| server | `final` + `"wouldFilter":reason`                                                                  | the filter is not on; it would have stopped this one                     |

## Voiceprint: "only my voice"

The owner asked on 2026-11-01 (21:28 JST) for real speaker enrolment and a
check that a line is his voice, as the base for hands-free voice approvals
later. The model is **CAM++** (3D-Speaker zh-en via sherpa-onnx, 28 MB,
192-dim), as #394 picked: it is the one that works across his iPhone and
Android today. ERes2NetV2 can be added per device later (below).

```
phone: mic (Silero VAD) ─ utterance ─▶ server.py ─┬─ SenseVoice decode        (as before)
                                                  └─ CAM++ + noise gate (own thread, side by side)
                                                       ↓ cosine to this device's print
       ◀─ final + speaker {score, decision: me | other | unknown, model, device} ─
```

**Enrolment.** The chat menu's **Voiceprint** (owner pages with
`lk:agent-local-stt`) opens a panel over the bar (`VoiceprintPanel.tsx`,
`voiceprint.ts`): what is enrolled per device, **Enrol this device**, **Test my voiceprint** (below), and
**Delete my voiceprint**. Enrol shows the **consent card first**: he will read
10–20 sentences; the Mac turns them into numbers that describe his voice,
not a recording, kept on the Mac at `~/.config/lianki-stt/voiceprints`;
after his passkey, a copy of those numbers in his Lianki account,
encrypted and readable only by his account (next-but-one section); what it
is for; that he can delete it all at any time; and a switch, off by default,
to also keep the sentences' recordings: on the Mac and, once saved to the
account, in his My Files → Voiceprint. **Nothing is captured until
his tap on "I agree, start" and his passkey** (next section). Voice can
neither start enrolment nor delete (docs/dev-debug-widget.md: recording is
turned on by a tap, never by voice).

### Voiceprint: who may enrol and delete

A page's own signals can be faked by page code (eval, a script's
`element.click()`), and any page that reaches the Mac (a friend's page on
lianki.com with tailnet reach, or the public tunnel with an STT ticket)
could otherwise send voiceprint ops. So the Mac takes **no voiceprint op
without a voiceprint ticket** from lianki.com, on any socket, tailnet or
tunnel (review of #411, 2026-11-02):

```
tap (isTrusted) → POST /api/dev/voiceprint-ticket {op, device, step:"options"}   owner session, else 404
               ← WebAuthn options: his passkeys, userVerification "required", a signed challenge token
navigator.credentials.get → Face ID / Touch ID (the OS prompt: page code cannot answer it)
               → POST {…, step:"verify", token, response}: assertion verified (@simplewebauthn/server),
                 UV flag required, the challenge spent in D1 (once), counter saved
               ← ticket {aud:"lianki-voiceprint", op, device, uv:true[, keepAudio], jti = the challenge,
                         iat/exp = the challenge's, fixed when it was issued}
page → the Mac {t:"enrol"|"voiceprint", op, …, ticket}   ticket.py: signature, aud, op, device, uv,
                                                          keepAudio, once (spent jtis kept on disk)
```

- **status** needs a read-only owner ticket (`uv:false`, the session alone);
  **enrol** and **delete** a passkey ticket for exactly that op and device
  (`*` for every device). An STT ticket (`aud:"lianki-stt"`) is refused, so
  is another op's or device's, a replay, or another key's. Commit and cancel
  name an enrolment by the unguessable id its start returned.
- **One approval, one ticket** (re-review, 2026-11-02). The challenge is
  spent at its first good verification by a primary-key insert into D1's
  `verification` table (`voiceprint-challenge:<challenge>`), so a replayed
  assertion (a synced passkey's counter stays 0) is refused ("approval
  already used"). The ticket's lifetime is the challenge's (60 s from the
  options), never reminted at verify. The Mac keeps spent jtis in
  `voiceprints/used-tickets.json` (0600) until exp + 5 s, so a restart
  forgets none; a file it cannot trust (loose mode, unreadable) makes it
  refuse every ticket.
- **Keeping the audio is approved too:** `keepAudio` goes into the passkey
  challenge and the ticket, and the Mac refuses a start whose `keepAudio`
  differs from the ticket's.
- The tickets are signed with the STT ticket key (`STT_TICKET_KEY` on the
  Worker; the Mac checks with `~/.config/lianki-stt/ticket.pub`, or
  `--voiceprint-pubkey`). **Without that public key on the Mac, every
  voiceprint op is refused** (`voiceprint ops off` in the log): set it up
  with step 2 of "Setting it up" above. The passkey is the owner's, from
  the profile page (lib/passkey.ts; D1 `passkey`); with none, enrol and
  delete answer 409.
- `__lkMic` (the page-wide mic session) has no voiceprint request: the
  panel opens its own socket to the Mac (`panelDeps`). The Enrol, Agree,
  Delete buttons also ignore untrusted (synthetic) clicks.
- **Delete wins over a pending enrolment.** Each device has a generation in
  `voiceprints/generations.json` (0600); a delete, from the panel or the CLI,
  bumps it (`*` for all). An enrolment remembers the generations it began
  with and refuses to commit after a delete; a delete on the server also
  drops the open enrolments of that device at once, so sentences still
  queued are not kept either. The server and the CLI share an exclusive
  `flock` on `voiceprints/.lock`, held across a commit's generation check
  and all its writes (prints, kept audio) and across a delete and its
  bump: a delete from another process either lands first (the commit is
  refused) or waits until the commit is written, then deletes it.

Then the panel shows one sentence at a time (20, in Chinese, Japanese and
English: `ENROL_SENTENCES`, reading material, not translated). Each
utterance goes over the same socket as speech, flagged `enrol`, and **only
to the Mac**: never into the draft, never to `/api/debug/stt`, never to the
clip sink (`createMic`'s `enrol` tap; with the Mac unreachable the sentence
is dropped and the card says so). The server keeps a sentence when it has at
least 1.5 s of speech, an SNR of 10 dB or more, and (from the fourth on) a
score of 0.2 or more against the ones kept so far; the card asks again
otherwise ("too short", "too noisy", "did not sound like the others"), and
also when the text is not the sentence shown (`matchesPrompt`: half its
letters, in order). **Save voiceprint** is enabled from 10 kept, and it saves
by itself at 20. Nothing is written before the save; Cancel or closing the
panel drops it. Each device enrols on its own (`deviceSlug`: iphone,
android, mac…; `lk:agent-voice-device` overrides it).

**Storage** (`scripts/local-stt/voiceprint.py` `Store`): on the Mac only,
`~/.config/lianki-stt/voiceprints/` (`LIANKI_STT_VOICEPRINTS` or
`--voiceprints` moves it), folder 0700, one file per device and model,
`<device>.<model>.json`, 0600, written atomically (a fresh 0600 temp file,
then a rename). It holds the embeddings, their mean, how long each sentence
was, and the leave-one-out self scores; no text, no audio. The opted-in
audio goes to `<device>.audio/NN.wav` (0700 / 0600). A file or folder that
is a symlink, not ours, or readable by others is refused (logged, the check
then says "unknown"). Never on the hub; never committed. The features (never
the audio) also go to his account when he saves them there ("Voiceprint in
your account", below).

**Delete.** In the panel: **Delete my voiceprint**, then a confirming tap;
it deletes every device's print. **It never deletes the kept enrolment
recordings with it** (owner, 2026-11-11): the Mac answers how many it still
keeps (`recordings`), and the panel then asks separately ("N recordings of
your enrolment are still kept on Lianki's speech servers. Delete them too?"). **Keep them**
is the default and the first button; only **Delete them from the speech servers** (one
more tap, its own `delete-audio` passkey ticket, or the window below) removes
them (`op:"delete-audio"`, `Store.delete_audio`). On the Mac:

```bash
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py list
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete --device iphone   # or --all; the print only
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete-audio --all      # only the kept recordings
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete --all --audio    # both
```

`delete` says how many kept recordings are left. The running server sees a
CLI delete on the next final (it watches the folder's mtime). None of these
touches `~/lianki-voice-clips`.

### Voiceprint in your account

The owner decided on 2026-11-10 (tap card, 23:31 JST): keep his voiceprint's
**features** in Cloudflare under his own account as well, so a new Mac can
get it back; then (23:33, 23:35 JST) the enrolment recordings too, in his My
Files, so the features can be computed again later (below). Flag
[`stt.voiceprint-cloud`](https://lianki.com/dev/flags#stt.voiceprint-cloud),
on by default, `audience: "owner"`, and only for an account holding `dev`
(the grant the voiceprint tickets already need); off: the print is on the Mac
only and `/api/my/voiceprint` answers 404.

```
tap "Save to my account" → passkey (Face ID / Touch ID) → ticket {op:"export", device:"*", uv:true, uid}
page → the Mac {t:"voiceprint", op:"export", ticket}        ticket.py: once; Store.export: features only
     ← {prints:[{device, model, dim, n, created, updated, self, speechS, centroid, embeddings}]}
page → PUT /api/my/voiceprint {ticket, prints}              the same ticket, spent once more on lianki.com
       lib/voiceprint-cloud.ts: exactly those keys (anything else, `audio` included: 400),
       the ticket's uid = the session's user, sealed (AES-256-GCM) → D1 voiceprint
```

- **What is kept.** D1 `voiceprint` (`db/migrations/0071_voiceprint.sql`),
  one row per account, device and model: `dim`, `n`, `updated_at` in clear,
  and `payload`, the sealed JSON of `{centroid, embeddings, speechS, self,
created, updated}`. No audio, no text, no file path, no `audio` flag: a
  print or a body with any other key is refused whole, on lianki.com
  (`parsePrint`, `PRINT_KEYS`) and on the Mac (`check_export`,
  `EXPORT_KEYS`); the page keeps only those keys too (`featuresOnly`).
- **Encrypted at rest.** The key is HKDF-SHA256 from the existing Worker
  secret `AUTH_SECRET`, salt `lianki/voiceprint`, info
  `lianki/voiceprint/features-at-rest/v1` (`voiceprintKey`): no new secret,
  and not the key that seals the Google tokens. The AAD is the row's user,
  device and model, so a payload moved to another row does not open.
  Rotating `AUTH_SECRET` leaves the rows unreadable: they list as
  `unreadable`; save again from the Mac.
- **Who.** Every read and write is by the session's user id; nothing in a
  request names an account. The session cookie only: an API token reads
  nothing here. Reading the features (`GET ?features=1`) needs the session;
  writing (`PUT`, an `export` ticket) and deleting (`DELETE`, a `delete`
  ticket) need a passkey ticket with `uv: true` **for this account** (the
  ticket's `uid`, added at verify), live (60 s), for that device or `*`.
  lianki.com spends each ticket once (`verification`,
  `voiceprint-cloud:<jti>`), apart from the Mac's own store, so one approval
  covers both halves of a tap and no more.
- **Restore** ("Restore from my account", the panel; also on a Mac with no
  print yet): passkey → `restore` ticket; the page reads the features
  (`GET ?features=1`) and sends them to the Mac (`op:"restore"`), which checks
  every print before writing any, recomputes the mean and self scores from
  the embeddings, and leaves a kept-audio folder and its flag as they were.
- **After an enrolment**, with the flag on, the panel saves to the account
  at once (one more passkey prompt). If the browser refuses the prompt (no
  fresh tap) or the save fails, the "Save to my account" button stays there.
- **Delete** ("Delete my voiceprint" and its confirming tap): one passkey
  `delete` ticket for `*`; the Mac deletes its prints (never its kept
  recordings: those are asked about separately, "Delete" above) and
  lianki.com deletes the account's rows. With the Mac away, the
  account's rows can still be deleted from the panel. His recordings in My
  Files are **not** deleted with it: the panel then asks separately ("Your N
  recordings are still in My Files → Voiceprint. Delete them too?"), and
  only that tap deletes them.

**The recordings** (owner, tap cards 2026-11-10 23:33 and 23:35 JST: keep
them in his account so the features can be computed again later; no
automatic deletion anywhere):

- "Save to my account" also asks the Mac for the recordings it kept (the
  enrolment's opt-in audio, `<device>.audio/NN.wav`; `export` with
  `recordings: true`, the same passkey ticket, `Store.recordings`: our own
  regular private files only, read, never moved or deleted) and uploads each
  to **My Files → Voiceprint** (`inbox_item` source `voiceprint`, his private
  R2 file store, `POST /api/import/files?source=voiceprint`), named
  `voiceprint <device> <enrolment day> NN.wav`. A name already there is
  skipped, so saving again stores nothing twice. That is also the one-time
  path for recordings already on the Mac: he taps "Save to my account".
  Nothing on the Mac is deleted by this, and `~/lianki-voice-clips` is never
  read.
- **Re-compute from my recordings** (a later model, a new Mac): the panel
  downloads them from My Files and hands them to the **feature extractor**,
  one interface (`FeatureExtractor.extract(device, clips) → {prints, ticket}`,
  `voiceprint.ts`) chosen by config `voiceprint.extractor` (/dev/config;
  `mac`, the only implementation for now; `GET /api/my/voiceprint` hands the
  value to the page). The Mac implementation takes a passkey `enrol` ticket
  for the device, opens an enrolment and feeds each recording as a sentence
  (the same checks), commits it on the Mac with `export: true`, and gets the
  new features back; lianki.com stores them under that same enrol ticket
  (an `enrol` ticket covers only its own device). A cloud worker can replace
  it by adding an implementation and changing the config.
- Retention: kept until he deletes them (in My Files, or the offer after a
  voiceprint delete). There is no automatic deletion path.
- Tests: `unit/voiceprint-cloud.test.ts` (sealing and AAD, features only,
  tickets for another account / op / device / without the passkey, each
  once, own rows only, the panel's three flows);
  `scripts/local-stt/test_voiceprint.py` `AccountCopy` and the server flow
  (export and restore only with their tickets, an `audio` key refused).

**Verification.** Every final is scored against this device's print (the
socket's `hello`), or, when this device has none, the best of the other
devices' prints (`device` in the result says whose). The decision
(`voiceprint.decide`):

| speech in the final | `me` at score ≥ | `other` under | otherwise             |
| ------------------- | --------------- | ------------- | --------------------- |
| < 1.5 s             | –               | –             | **unknown** (`short`) |
| 1.5 – 3 s           | 0.28            | 0.18          | unknown (`between`)   |
| ≥ 3 s               | 0.30            | 0.20          | unknown (`between`)   |
| SNR < 10 dB (any)   | –               | –             | **unknown** (`noise`) |
| nothing enrolled    | –               | –             | unknown (`no-print`)  |

`me` is #394's threshold for 1 % false accepts over 109 other voices (real
people, TTS in nine languages, the shop PA, voices in the background) at
that length: CAM++ 0.278 at 2 s, 0.300 on whole clips. `other` is #380's
0.2, 0.02 lower on short speech. The speech length and SNR come from frame
energies (`speech_stats`): calibrated on his 20 referenced clips under DEMAND
restaurant noise, a true 20 / 10 / 5 / 0 dB reads as 19.4 / 11.2 / 7.8 / 5.0
(medians), so the gate holds 5 dB back and lets 10 dB through.

**The enrolment caveat.** #394's thresholds came from a 5-fold enrolment
on his conversational iPhone clips, not from sentences read aloud on each
device. Read speech and a per-device print will shift his own scores
(likely up, on the same channel). The server logs every final's decision
and score (`final #12: … spk me 0.412 (me 30 other 1 unknown 9)`, never the
text) and the enrolment's own spread (`self {min, median}`); re-check the
bands on those after he enrols, before anything relies on them.

**What uses it.**

- **Passive (wake) mode:** after a "Linky" hit, the whole utterance goes to
  the Mac first (the text read from after the keyword, `textFrom`). If the
  check says **other**, the line is dropped, the mic stays passive, and the
  devLog gets `{ev: "speaker-other", mode: "passive", n, score, model}`
  (a count, never the text). **unknown** passes, as before; so does a
  failure of the Mac (the rest goes to the cloud, unchecked).
- **Active mode:** nothing is dropped unless he turned on the filter below
  (#380: noise and a talker under him still cost his own speech). An "other"
  counts as one rejection towards passive (docs/wake-word.md, "State machine").
- **The line, signed:** the Mac signs each final's tag together with its
  text, `{v:1, uid, thread, at, text, decision, score, model, device, …}`,
  where `uid` is the page's fresh id for that utterance (`begin`) and
  `thread` the hub thread the page named in its hello ("owner"), with an
  Ed25519 key only it holds (`~/.config/lianki-stt/speaker-attest.key`,
  0600; `voiceprint.py attest-key` makes it and prints the public key). The
  page passes the signatures on with the line (`speakerProof`, one per
  utterance); a page-made `speaker` is ignored. The hub (lianki-push, secret
  `STT_SPEAKER_PUB`) keeps a `speaker` tag on the stored line only when every
  proof verifies, is under 10 min old, was signed for this line's thread,
  and its uid was never used, and the signed texts, in order, are exactly
  the line (`lib/speaker-proof.ts` `lineIsSigned`). The only differences
  allowed are meaning-neutral: Unicode NFKC (？ and ? are one mark),
  whitespace collapsed, utterances joined by a space or nothing, and one
  "。" or "." the mic appends right after a signed text that had no final
  punctuation. Signed punctuation is never stripped or substituted: a
  signed ？ cannot become ！ or vanish (a question made an order), a … must
  stay, and no ！ or ？ may be added (so a ？ the mic's formatter guesses for
  an unpunctuated final also leaves the line untagged; SenseVoice nearly
  always punctuates itself). A dropped word (a negation), an added or
  replaced one, or the utterances reordered leave the line without a tag.
  The stored tag carries the signed texts themselves (`speaker.signed`). Used uids are burned in the hub's
  Durable Object storage (`proof:<uid>`) for twice the window, so a restart,
  hibernation or deploy forgets none; the alarm sweeps them. So no tag can
  be forged, replayed or moved onto other words. It computes the tag itself
  (the weakest utterance). Only such a tag shows the small green check
  (`VoiceMark`, "Your voice, verified"). Without `STT_SPEAKER_PUB` no tag is
  ever kept.
- **Not built:** the voice approvals themselves. **They must rely on this
  hub-verified tag only**, never on anything a page reports, and must
  read the words from `speaker.signed`, never from the displayed line.

**Latency** (`scripts/local-stt/voiceprint-bench.py`, 2026-11-01, 40 of his
clips 1.8–14.4 s, a throwaway print in a temp folder, at `nice 20` and
background QoS, one thread each, beside the live server):

|                                               | median    | p90       | max    |
| --------------------------------------------- | --------- | --------- | ------ |
| SenseVoice final alone                        | 300 ms    | 553 ms    | 876 ms |
| CAM++ + gate alone (17.7 ms per audio second) | 78 ms     | 147 ms    | 243 ms |
| both side by side, as the server runs them    | 307 ms    | 572 ms    | 958 ms |
| **added to a final**                          | **13 ms** | **52 ms** | 111 ms |

At normal priority (the live server: P-cores, the decode on 4 threads) the
background figures are about 3× too slow (#394's unloaded check), so CAM++
is about 25 ms on a median final and 6 ms per audio second, under the
decode's ~9 ms per second: it finishes inside the decode and adds about
**0–10 ms** (an estimate, not a foreground measurement). Memory: about 150 MB
more at peak (CAM++ loaded and a 10 s embedding, measured).

**Switches.** On by default where the model is
(`~/.cache/lianki-stt/models/speaker/campplus_zh_en.onnx`); without it, or
with `--speaker ""` / `LIANKI_STT_SPEAKER=0`, the server logs `speaker check
off` and works as before. `--speaker campp,eres2netv2` loads both: enrolment
then saves a print for each, and verification uses, per device, the first
model in that list with a print. ERes2NetV2's bands (0.34 / 0.25, ≥ 3 s:
0.37 / 0.27) are #394's 1 % FA points and marked `provisional`; it needs a
per-device enrolment (#394: it rejected 85–98 % of his Android clips
against an iPhone enrolment).

### One approval for ten minutes

The owner's tap card (2026-11-11 01:28 JST): **one** passkey approval (Face
ID / Touch ID) covers **all** voiceprint ops (enrol, save to account,
restore, delete, delete the kept recordings, re-compute, export) for ten
minutes. Config [`voiceprint.passkeyWindowMs`](https://lianki.com/dev/config)
(default 600000; 0 = a prompt per op, as before; at most 30 min).

```
tap → options → Face ID → POST {…, step:"verify", client:"iphone"}
     ← {ticket, grant, grantExp}     grant: {aud:"lianki-voiceprint-grant", uid, sid, client, gid, iat, exp = now + window}
next op (no prompt) → POST {op, device, step:"grant", grant, client}
     ← {ticket}                      the same ticket as before: aud, op, device, uv:true, uid, a fresh jti,
                                     iat = now, exp = min(now + 60 s, grant exp)
page → the Mac {…, ticket}           ticket.py: unchanged (aud, op, device, uv, keepAudio, once)
```

- **Bound** to the account (`uid` = the session's user), the sign-in session
  (`sid`, a SHA-256 tag of the session id, never the id) and the page's device
  slug (`client`). Another account, session or device: 401, and the page
  asks for the passkey again. A sign-out ends the session, so the grant is
  refused even if a copy survived.
- **In page memory only** (`webauthn.ts`, a module variable, not
  localStorage, sessionStorage or `globalThis`): a reload drops it. The panel
  shows "Face ID approved: … until 14:05" with **End now**, which drops it.
- **Each op still gets its own single-use ticket**, its own jti, at most 60 s
  and never past the grant; within 5 s of the end the page asks for the
  passkey instead. A shorter window set at /dev/config shortens grants
  already out (the check is `iat + window`, read at each mint); 0 ends them.
- **Never anything else.** The grant's audience is accepted only by the
  `grant` step of `/api/dev/voiceprint-ticket`; it is not a challenge, not a
  ticket, and no other step-up (payments, permissions, API tokens, sign-in)
  reads it. `status` needs no passkey at all, as before.
- **The trade-off** (also docs/security-measures.md, section 14): inside the
  window, page code on that device and session (an eval, an injected script,
  an extension) can get voiceprint tickets without his face, so it could
  delete the print or the recordings, export or restore, or start an
  enrolment that keeps audio (keepAudio comes from the consent card's switch,
  no longer re-approved by Face ID inside the window). Ten minutes, one
  device, one session, one account, and **End now**; the Mac still spends
  each ticket once.
- Tests: `unit/voiceprint-window.test.ts`.

### Test my voiceprint

Owner, 2026-11-11 01:03 JST. **Test my voiceprint** in the panel (dev
permission, like the panel) routes the mic to the test: each utterance goes
to the Mac as a plain final on the mic's socket (the `hello` names this
device, so it is scored against this device's print), and only to the panel:
never the draft, the cloud STT or the clip sink (the enrolment tap with no
enrolment id, `enrolCapture(…, "", true)`). Nothing is stored: the Mac keeps
no audio of a final, and the panel keeps only each line's verdict, in memory.

Per line, at once: the decision (**Me** / **Someone else** / **Not sure** and
why: too little speech, too noisy, between the two lines, no print), the
CAM++ score, whose print it was scored against and the model, the speech
seconds and SNR, and the thresholds used for that length (from the Mac's
status answer `bands`, `voiceprint.bands_info`; the table in "Verification" above as the
fallback). A running tally (me / someone else / not sure), and after the
first line: "Now let someone else say one sentence, to compare." The state
of the "only my voice" filter, with a link to
[`stt.voiceprint-filter`](https://lianki.com/dev/flags#stt.voiceprint-filter),
and per line whether the filter stopped it or would have. **Done** gives the
mic back to the chat; closing the panel does too.

## Only my voice: the filter

Approved by the owner's tap on 2026-11-06 (about 01:02 JST). **Default off**:
flag [`stt.voiceprint-filter`](https://lianki.com/dev/flags#stt.voiceprint-filter).
With it on, a final on his local route that clearly is not his voice is not
transcribed and not posted. It filters this route only (`server.py`), never
another user, and it is **not a security gate**: voice approves nothing,
with or without it.

```
page ─ GET /api/dev/voice-filter (owner, else 404) ─▶ flag
     ─ {t:"filter",on:true} ─▶ server.py: this socket only, off until said
utterance ─▶ CAM++ first ─ clear mismatch ─▶ final {text:"", filtered:{reason,score}}: no decode, no proof, no text in any log
                         └ otherwise ─────▶ SenseVoice, as before
```

**When it stops a final** (`voiceprint.filter_reason`, all of these):

- this device has its own print (a print from another device says nothing:
  the channel moves his scores too much, below);
- CAM++ scored it **under 0.15** (`FILTER_BELOW`), well under the tag's
  "other" line (0.18–0.20);
- at least **2 s of speech**, and a read SNR of at least **8 dB** (a true SNR
  of about 5 dB).

Anything else passes: short words, noise, no print, a model that fails, a
store it cannot read. Then behaviour is exactly as today, and so it is on the
cloud route (the Mac is unreachable: nothing to check with; the dot says so).

**What it costs.** With the filter on, the check runs before the decode, not
beside it, so a final waits about 6 ms per audio second more (30 ms on 5 s; an
estimate from "Latency" above, not a foreground measurement). Partials wait
until 2 s of speech have been heard and not stopped, so the first partial comes
at about 2–2.5 s rather than 0.43 s. With the filter off, neither changes.

**Seeing it.** On his device, never text:

- a short note over the mic for 3 s when a line is stopped ("Not your voice: not sent");
- Voiceprint panel (chat menu): whether it is working, today's count, the last
  score; with the filter off, the count it **would** have stopped (the lines
  still land), which is the real measure of false rejects on his own speech;
- the devLog: `voice-filtered {n, reason, score, durationMs}`,
  `voice-would-filter {…}`, `voice-filter {on}`;
- on the Mac: `final #12: 4.2s audio, filtered no-match 0.07 (3 filtered)`.

A stopped line goes nowhere else: not the cloud, not the clip sink
(`filterVerdict`, `MicButton.tsx`). In passive mode it is dropped as "other" is.

**Off.** The flag (a change reaches the page within 30 s, at the next
utterance; nothing polls), or **Pause on this device** in the panel
(`lk:agent-voice-filter` = `off`, at once).

**The print.** Only his, read by him in the Voiceprint panel, on each device
he uses (above). Nothing was enrolled from the clips: they hold other people's
voices too. The evaluation below uses throwaway means in memory only; other
voices' embeddings go with the process.

### Where the line comes from

`scripts/local-stt/voice-filter-eval.py`, 2026-11-06, files only, aggregates
only. **No real print exists yet**: his side is held out of a throwaway mean of
his 20 labelled iPhone clips (labelled by an agent, see
[stt-ab.md](stt-ab.md), "References"). Run it again with `--real-print` after he
enrols, before relying on the line: reading aloud on the device will shift
his scores.

| his own speech, at line 0.15 (≥ 2 s, ≥ 8 dB)                | n       | stopped       |
| ----------------------------------------------------------- | ------- | ------------- |
| whole clips, 5-fold; clean, phone band, dull, −12 / −24 dB  | 20 each | 0             |
| 3 s and 5 s crops                                           | 32, 19  | 0             |
| restaurant 20 / 10 / 5 / 0 dB, street 10 dB (whole)         | 20 each | 0             |
| only 10 clips in the mean, 30 draws (the panel's minimum)   | 300     | **8 (2.7 %)** |
| the 191 unlabelled clips (a mixture: an upper bound on his) | 191     | 0             |

Zero of 71 clean whole and cropped clips has a 95 % upper bound of about 4 %,
so read "0" as "under 4 %". The 2.7 % comes from a few poor means: **read all 20
sentences at enrolment**, not 10.

| line (same gates) | his, 10 clips in the mean    | real people, clean: whole · 3 s | TTS, clean | shop PA  | real people · TTS, in a noisy room |
| ----------------- | ---------------------------- | ------------------------------- | ---------- | -------- | ---------------------------------- |
| 0.08              | 0.7 %                        | 29 % · 18 %                     | 73 %       | 17 %     | 29 % · 19 %                        |
| 0.12              | 2.3 %                        | 43 % · 36 %                     | 83 %       | 33 %     | 50 % · 23 %                        |
| **0.15**          | **2.7 %**                    | **71 % · 55 %**                 | **88 %**   | **58 %** | **57 % · 27 %**                    |
| 0.18              | 3.7 % (his 3 s crops: 3.1 %) | 79 % · 82 %                     | 92 %       | 83 %     | 57 % · 27 %                        |

**What this does not show.**

- **It may catch little of what he actually hears.** Against his iPhone mean,
  **0 of the 191 unlabelled clips** would have been stopped. Some of those are
  other voices; many are him talking in the room, which no voiceprint can
  filter. The wake word is for those. The rates above are public recordings
  and TTS, on another channel. His household's voices on his own phone are not
  in the data, and they are the case that matters.
- **Others under 2 s of speech always pass.** So do those under 8 dB.
- **A whisper, a cold, a Mac mic:** not in the clips (all phones). The phone-band,
  dull and quiet channels held up, but they are simulations, not those. A whisper
  has no voiced pitch and may score low. This is why each device gets its own print
  and why the filter's first days should be spent off, on the "would have been
  stopped" count.
- **A same-device print raises every score.** A mean from 5 of his Android clips
  moved the other 80 from a median of 0.34 to 0.61. That is good for him, but
  someone else in that room may gain as well: it may stop fewer of them.

**ERes2NetV2 may suit the filter better, on the same device.** The same run at
line 0.20 (2 s, 8 dB) stopped 0.3 % of his clips with 10 in the mean (CAM++ at
0.15: 2.7 %) and 0 of the same 20 and 32 clean ones, and caught 64 % of real
people and 79 % of TTS, close to CAM++'s 71 % and 88 %, but 33 % of the PA against
58 %. It has no filter line yet, so it filters nothing. An enrolment saves a print for
each model the server has loaded (`--speaker campp,eres2netv2`, about 71 MB more on disk);
with only `campp` loaded, adding it later means reading the sentences again.

Suggested order: enrol, leave the flag off for a day of talking, look at the
"would have been dropped" count, then turn it on.

## Short utterances and the language

SenseVoice's auto language ID gets short Japanese wrong. On 2026-10-31 the
owner said 「もしもし」 three times (2–3 s each). `language="auto"` gave
'Moice, miss.' (en), 'Mice mouse.' (en) and '没关系没关系。' (zh); with ja
forced, all three read 「もしもし。」. He mixes Chinese, Japanese and English,
so no language can be fixed.

**What the server does** (`engines.py`, `SenseVoice.final` + `LangPicker`):
a final of **4 s or less** is also scored by the same model, int8, run through
onnxruntime once as a batch of three: language `auto`, `ja` and `zh`. That runs
on a side thread while sherpa-onnx does the usual auto decode. A forced reading
replaces the auto one only if all of these hold (`choose()`):

- it is in its own script: kana for ja; Han and no kana for zh;
- it is not the auto language (yue counts as zh);
- its mean best log-prob per frame (CTC, blanks included) beats auto's by at
  least **0.02**;
- its mean log-prob per emitted token beats auto's by at least **0.4**.

If both forced readings qualify, the larger per-frame gain wins. Partials and
longer finals are the auto decode, exactly as before. The scores have to come
from onnxruntime because sherpa-onnx returns only the argmax for SenseVoice
(`ys_log_probs` is empty). The filterbank is numpy (`fbank()`, the same as
kaldi-native-fbank to within 1e-3 in log-mel), so nothing new needs
installing. `LIANKI_STT_LANG_PICK=0` turns it off, and so does a missing
`model.int8.onnx` or onnxruntime. Either way the server logs `lang picker off`
and works as before.

**Measured** on 2026-10-31 over the owner's 211 saved clips, files only:

| set                                                      | clips | auto only | with the pick |
| -------------------------------------------------------- | ----- | --------- | ------------- |
| short Japanese                                           | 7     | 4         | **7**         |
| short Chinese (2 of them were misread as en by auto)     | 30    | 28        | **30**        |
| short English                                            | 10    | 10        | 10            |
| other short clips, unlabelled (mostly background, noise) | 96    | –         | 7 switched    |
| longer than 4 s                                          | 68    | –         | untouched     |

The labels are the agent's own judgement, made from the forced decodes and
the conversation around each clip; no clip had a `.ref.txt`. The thresholds
were tuned on this same small set, and it has only three misread Japanese
lines, so these numbers are optimistic. Every labelled English and Chinese
line that was right stayed right. The 7 unlabelled switches are clips where
neither reading can be checked without listening: background talk and
one-word replies.

**Cost.** The scorer takes a median of 2.1× one auto decode of the same clip
(332 ms against about 170 ms when measured on 2 threads at background
priority, beside the live server). It runs alongside the auto decode, so the
final waits about 1.1× an auto decode longer. At normal priority a ≤ 4 s
utterance decodes in about 20–40 ms (about 9 ms per audio second, "Which
engine"), so the expected cost is about **25–45 ms** per short final, and
nothing on long ones. That is an estimate scaled from the background
measurement, not a foreground measurement. Memory is about 0.3 GB more (the
int8 session).

**Not chosen:** sending the page's hint (`stt-hint.ts`) per stream. The hint
is learnt from typed lines, so it is one language at a time, mostly zh for
him, and it would push 「もしもし」 towards zh. A per-device "primary languages"
setting has the same problem: all three are primary for him. Calling
`set_config(language=…)` on sherpa for forced decodes works, but it gives no
scores to choose between the readings, and it changes the recognizer for every
decode running at the same time.

## Booked as a cloud service

The speech server costs us nothing per call, but each utterance it serves is
booked to the account's cost ledger at a cloud-equivalent rate, so /dev/costs
shows what the voice features would cost on a cloud provider
([payments.md](payments.md), "Cost ledger"). The utterance never reaches
lianki.com, so the page reports its length (`reportLocalStt` in `mic.ts`,
from `MicButton.tsx` and /vibe's `served`) to `/api/debug/stt/local`; the rate
is the config key `stt.local.costPerMinUsd`. Nothing is charged.

## Fallback

`createLocalStt` (`packages/debug-chat/src/local-stt.ts`) opens the socket
when the mic turns on and keeps it open while the mic is on (`keep(true)`):
it reopens at once when the socket closes, on `visibilitychange` to visible
and on `online`. These are events, not a timer: after a failed open (or a
socket that dropped within `STABLE_MS`, 10 s, of ready), the next event waits
out a backoff of 1 s, doubling to 30 s, as one deferred attempt; a failure
schedules nothing by itself. A page that is hidden waits for visible.

An utterance that starts with the socket down is **held, not sent to the
cloud**: it opens the socket at once (skipping the backoff), buffers the
frames, and streams them behind its `begin` the moment the server says
`ready`, then goes on live; an `end` that came first is sent right after.
Only if opening fails (all URLs, or `CONNECT_TIMEOUT_MS`, 2.5 s, from the
race's start) does its final reject, so it takes the route. The wait costs
nothing unless the connect outlasts the utterance itself; the devLog shows it
as `local-stt {state:"held-streamed", heldMs, frames, ended}`. With the
socket up, the path is exactly the old one (same messages, same timers;
measured 294 vs 295 µs per one-second utterance on a fake socket). While held
the mic uses the streaming endpoint and no chunk partials, so an utterance
that does fall back has no partials shown.

After "Linky" in passive mode, the rest of the utterance (already whole) goes
to the Mac too when its socket is up, as a pre-pad and an `end`; with it down
the rest goes to the cloud at once, without waiting for a connect.

Each close the page did not make is logged with the browser's own close
event: `local-stt-close {code, reason, wasClean, via, livedMs}` (and `phase:
"race"` for a socket that lost before `ready`). iOS sends no close frame, so
on the server such a drop shows only as "page detached"; on the page it is
typically `1006`, not clean.

An utterance begun while the mic is passive is not streamed. The final is
handed to the upload as `info.local` (`packages/debug-chat/src/mic.ts`); the
upload in `MicButton.tsx` awaits it and, on any rejection (unreachable,
socket closed, `error`, no final within 4 s), posts the WAV to
`/api/debug/stt` instead. The echo guard, the hallucination guard and
the clip sink see the text exactly as they do a route transcript.

### Which engine a line came from

Every voice line carries `stt: {route: "local"|"cloud", engine?, fallback?:
true}` (`wire.ts` `SttTag`), set by the page from what actually answered its
final: `route: "local"` with the server's final `model` (e.g.
`sensevoice-small-2024-07-17-int8`), or `route: "cloud"` with the route's
`model` (`@cf/openai/whisper-large-v3-turbo`, or `@cf/openai/whisper` when the
route fell back itself). `fallback: true` = the Mac was asked and failed, so
the cloud answered. MicButton marks it on the utterance in the latency store
(`latency.ts` `takeLine`); push to talk is always the cloud. The hub keeps it
on the stored line (and on each part of a merged one), `eval.ts chat` /
`lianki-dev listen` print it, and the chat shows a tiny tag after the line
("local · sensevoice-small-…", "cloud · whisper-large-v3-turbo · fallback")
only to a `dev` holder (DebugChat `owner`). Never text, never for friends or
normal users.

## Noise

The browser's own noise suppression, echo cancellation and auto gain are on
(`voice-out.ts`). A speech enhancer on the Mac before SenseVoice was tried
and **is not used**: DeepFilterNet3 (`--enhance dfn3` in `engines.py`,
~22 ms per audio second with the 16→48→16 kHz resampling) made SenseVoice
worse in every condition. `bench-noise.py`, on the clips and noisy copies
made by `noisy.py` (files only, never played: babble = three of the owner's
other clips mixed in, pink noise), scored as CER against SenseVoice on the
clean clip:

| audio          | clips | CER raw           | DFN3  | DFN3, 10 dB cap |
| -------------- | ----- | ----------------- | ----- | --------------- |
| clean          | 13–14 | 0 (the reference) | 0.102 | 0.017           |
| pink, 5 dB SNR | 12    | 0.196             | 0.254 | 0.507           |
| pink, 0 dB     | 12    | 0.368             | 0.480 | 0.591           |
| babble, 5 dB   | 12    | 0.545             | 0.704 | 0.588           |
| babble, 0 dB   | 12    | 0.871             | 0.840 | 0.864           |

That matches what is known of enhancement before ASR: the model was trained
on natural noisy speech, and the enhancer's artifacts hurt it more than the
noise does. Babble of the owner's own voice is the hardest case there is
(and not realistic); in a real café the gain from close talking (the phone
near the mouth) and the noise-adaptive endpoint are the levers. Hold-to-talk
remains the option if those are not enough.

Re-checked on 2026-10-31 with real noise types (DEMAND restaurant and
street, a shop PA, a family voice) and five denoisers: RNNoise, DFN3 with
and without a cap, noisereduce and spectral subtraction. None beats no
denoiser, and each costs 0.04–0.10 CER on clean speech. A speaker check
(CAM++ / ERes2NetV2) is what keeps the PA and background voices out:
[stt-ab.md](stt-ab.md), "Noise and speaker grid".

## Lianki's speech servers for everyone

The owner's decision (Slack, 2026-11-11 00:3x–00:4x JST): the same
SenseVoice-Small server becomes a public-grade service for other accounts.
Everything ships **dark** behind flag
[`stt.worker`](https://lianki.com/dev/flags#stt.worker) (default off,
audience: the `/dev/stt-access` allowlist). With it off every endpoint below
answers 404, and **the owner's own mic route is unchanged** (tailnet, then
`stt.lianki.com` with a v1 ticket, then the cloud, exactly as above).

```
page ─ POST /api/stt/session (flag, allowlist, quotas) ─▶ lianki.com Worker
     ◀─ {ticket v2, ice servers, signal URL} ─
page ─ WebRTC: offer/answer + ICE over wss://lianki.com/api/version/stt/signal ─▶ SttRegistry (lianki-push DO)
                                                                            ◀── stt-peer on a worker (dials OUT, Ed25519 worker key)
page ═ DataChannel (STUN direct; TURN fallback) ═▶ stt-peer ─ ws ─▶ server.py peer listener (verifies the v2 ticket)
     else WSS tunnel, else Workers AI (/api/debug/stt), per utterance
```

- **User-facing text** says only "Lianki's speech servers" (see the top of
  this doc). Free for now; each utterance is booked at cost as
  `speech.stt.local` ("Booked as a cloud service").
- **Weak spots** (homophones, dropped words) are left to the replying AI's
  polish, as for the owner's lines.
- **Later**: a user's own Mac as their personal worker. The worker registry
  is per account capable (`stt_worker.owner_user_id`) and the page's route
  race is pluggable (one transport per route kind).

**Ticket v2** (`lib/stt-ticket.ts` `signSttTicketV2`, `ticket.py` with
`aud=V2_AUD`): `{aud:"lianki-stt2", v:2, jti, iat, exp, sub, scope:"stt",
lim:{utt, sess}}`, 60 s, single use, the same `STT_TICKET_KEY`. Its own
audience: the owner's tunnel listener never takes one, and a v1 ticket never
opens a public session. `sub` is the account id (never an email) the session
is booked to; `lim` the longest utterance and session the server enforces,
signed, so the page cannot raise them. Bad claims are refused before the jti
is spent.

**Quotas** (config, `/dev/config` group `stt-worker`; defaults are the
owner's numbers): `stt.worker.sessionsPerAccount` 1,
`stt.worker.ticketsPerMin` 6, `stt.worker.minutesPerDay` 30,
`stt.worker.maxUtteranceS` 40, `stt.worker.sessionMaxS` 900,
`stt.worker.macCapacity` 3 with `stt.worker.macReserved` 1 kept for the
owner. Over any of them the utterance goes to the cloud, as on any failure.

**Who** (`/dev/stt-access`, admin; `lib/stt-worker/store.ts`, migration
0073): `stt_access` is the allowlist (default deny), `stt_worker` the speech
servers allowed to register (Ed25519 public keys; `owner_user_id` set = a
user's own server, later). Every change is in `security_audit`, ids only.

**`/api/stt/session`** (`lib/stt-worker/session.ts`): 404 while the flag is
off, whoever asks. `GET` answers 204 for an allowlisted account (the page asks
once when the mic turns on, never in an utterance's path), else 404. `POST`
(same-origin JSON) checks, in order: signed in (401), on the list (403,
`not-allowed`), `sessionsPerAccount` > 0 (403, `off`), tickets in the last
minute under `ticketsPerMin` (429, `too-many-tickets`; D1 `stt_ticket`), audio
today (JST) under `minutesPerDay` (429, `daily-limit`; the account's
`speech.stt.local` rows in the cost ledger), the signing key set (503,
`tickets-off`). Then: `{ticket, exp, signal, iceServers, limits[, wss]}` — the
v2 ticket, `/api/version/stt/signal`, STUN from config `stt.worker.stunUrls`
plus TURN when its key is set, and the WSS fallback when config
`stt.worker.wssUrl` names one (empty by default: no tunnel exists yet).
TURN credentials are minted per session from Cloudflare Realtime TURN with
the Worker secrets `STT_TURN_KEY_ID` / `STT_TURN_KEY_TOKEN` (**not set**: the
owner's approval first); without them STUN only.

**The registry** (`workers/push/src/stt-registry.ts`, Durable Object
`SttRegistry` in lianki-push, binding `STT`; no route of its own: the existing
`lianki.com/api/version/*` route reaches it). Both paths are 404 while the flag
is off (lianki-push asks `DebugSessions.flag`) and for anything but a socket;
no cookie or identity header passes to it.

- `/api/version/stt/worker`: a speech server's `stt-peer` dials **out** (no
  inbound port on the server; an Origin is refused: not a browser). The hub
  sends `{t:"challenge", nonce}`; the worker answers `{t:"auth", key, sig}`,
  Ed25519 over `lianki-stt-worker\n<nonce>`; the key must be a live
  `stt_worker` row (`DebugSessions.sttWorker`, only while the flag is on),
  else 4401/4403. One socket per worker: a reconnect replaces the old one.
- `/api/version/stt/signal`: a lianki.com page offering `lianki-stt2, <v2
ticket>`. Before the upgrade: the ticket (signature with
  `PARTNER_TICKET_PUB`, the same key pair's public half; claims; once, jtis in
  the DO's storage) else 401; the account's live sessions under
  `sessionsPerAccount` else 429; a worker with room — the account's own worker
  first (`owner_user_id`), then the least busy shared one under its capacity
  (`stt_worker.capacity` or `macCapacity`) minus `macReserved` — else 503.
  Then `{t:"ready", sid}`, and offer / answer / ICE pass between that page and
  that worker only; the ticket goes on to the worker with the offer, and its
  speech server checks it again. A worker speaks only for its own sessions.
- **Booking**: the worker reports each final's audio length (`{t:"usage",
sid, audioMs}`) and the hub books it to the ticket's account
  (`DebugSessions.bookStt`: `speech.stt.local`, at most 120 s per report, the
  `stt.local.costPerMinUsd` rate). The page does not book these itself.
- A session counts until its signed length plus 60 s (checked when the hub
  next counts; no timer), or until the page's signal socket closes; a worker
  that goes away ends its pages (`{t:"end", reason:"worker-gone"}`), which go
  on with the next route.
- **Adding a worker** (after the owner's tap card): `stt-peer keygen` on the
  server prints its public key; `bun scripts/local-stt/stt-worker-add.ts --id
mac --name "…" --key <public key>` writes the row (wrangler d1, audited as
  `cli`). Revoke on `/dev/stt-access`.

**stt-peer** (`scripts/local-stt/stt-peer`, Go + pion/webrtc): the sidecar on
a speech server. It keeps one connection to the registry (dialled out; after a
drop it dials again, waiting 1 s doubling to 30 s), answers each offer with a
peer connection (STUN from `--stun`; the page's TURN when its ICE servers
include it), and bridges the page's DataChannel `stt` one-to-one to a fresh
socket on server.py's peer listener: text to text, binary to binary, the same
protocol as every other route. The page's v2 ticket goes along in
`Sec-WebSocket-Protocol` with Origin `https://lianki.com`; **server.py checks
it itself**, so the bridge decides nothing about who may speak. It reports
each final's `audioMs` to the registry for booking, refuses offers past
`--capacity` (`{t:"end", reason:"busy"}`), and never logs text, audio or
tickets. Its key: `stt-peer keygen` writes `~/.config/lianki-stt/worker.key`
(the Ed25519 seed, 0600, never overwritten) and prints the public half; a key
file that is a symlink, not ours, or readable by others is refused. Build and
run (the toolchain from go.dev, checksum checked, in `~/.cache/lianki-stt/toolchain`):

```bash
cd scripts/local-stt/stt-peer && go build -o ~/.cache/lianki-stt/stt-peer .
~/.cache/lianki-stt/stt-peer keygen          # once; then the owner's tap card, then stt-worker-add.ts
oxmgr start --name lianki-stt-peer --restart always "$HOME/.cache/lianki-stt/stt-peer --server ws://127.0.0.1:5189"
```

**The peer listener** (`server.py --peer-port 5189 [--peer-max 2]`, off by
default; 127.0.0.1 only): checks, before the upgrade, Origin lianki.com (403),
a free slot (503), and a **v2** ticket beside `lianki-stt2` (401; a v1 ticket
or the owner's subprotocol is refused). The ticket's `lim` holds on the
socket: audio past `utt` seconds is not kept, and the socket closes with 4408
after `sess`. **None of the owner's voiceprint features answer there**: no
speaker check, no speaker proof (the hub would never take one for another
account), no filter, and enrolment and voiceprint ops answer `not on this
route`. Per-account prints, when they come, live under
`voiceprints/accounts/<hash of the account id>` (`account_store`), never in
the owner's folder. The owner's own listeners (tailnet, tunnel) are unchanged.

**The page** (`packages/debug-chat/src/public-stt.ts`). Only where the owner's
route is "none" (not the owner: `localSttRoute` decides first, so his page
never changes) and only on `https://lianki.com`: the first time the mic turns
on in a page, `GET /api/stt/session` once (404: nothing more happens, the mic
is exactly as before). On 204 the consent card (`SttServersCard.tsx`, strings
`sttServers*` in `chat-ui-locales.ts`, 16 locales): "Your voice goes to
Lianki's speech servers, which write it out while you speak. The audio is not
stored; only what you send is kept. Free for now." — **Use Lianki's speech
servers** / **Not now**. Nothing is sent before that tap (a synthetic click is
ignored); the answer is kept per device (`lk:stt-servers`, `on` / `off`;
"Not now" asks again on the next page). Agreed, the mic's route list becomes
`PUBLIC_ROUTES` = `rtc:lianki wss:session`, raced by the same
`createLocalStt` (protocol, held utterances, fallback, dot), with `open` =
`publicOpen` and a longer `connectTimeoutMs` (6 s: a session, signalling and
ICE come before `ready`):

- `rtc:lianki`: `POST /api/stt/session` → the registry's signal socket
  (`lianki-stt2, <ticket>`) → on `ready`, an `RTCPeerConnection` with the
  session's ICE servers and a DataChannel `stt` (ordered) → offer, trickled
  ICE, answer. The channel, once open, is the socket. The signal socket stays
  open for the session (the registry counts by it).
- `wss:session`: its own session (a ticket is spent once per route); the
  session's `wss` URL with `lianki-stt2, <ticket>`, or an at-once failure when
  there is none (the default).
- No hello, device, thread or filter on these sockets, and the page does not
  report usage (`reportLocalStt`): the registry books it. Any failure before
  `ready` loses the race; all lost = the cloud, per utterance, as always.
  The order is the pluggable part (later: a user's own Mac first).

## His own Mac over WebRTC

The owner's decision (2026-11-11): the user trusts Lianki and the devices they
trust themselves, and the transport is WebRTC. First case: his phone reaching
his own Mac over WebRTC, beside (or instead of) the tailnet socket.

- **The Mac is his own speech server**: `stt-worker-add.ts --owner <his
account id>` writes the `stt_worker` row with `owner_user_id` (the registry
  sends an account's sessions to its own worker first) and
  `~/.config/lianki-stt/peer-owner` (0600). Only after his tap card.
- **server.py's peer listener** (`--peer-owner-file`, that file by default):
  a v2 ticket whose `sub` is that account is an **owner session**: his
  device, thread, voiceprint check, proof and filter, and no ticket limits.
  Any other account stays a guest, exactly as before. A file that is a
  symlink, someone else's or writable by others is ignored.
- **The page**: his stored route list may mix `rtc:lianki` with his own
  URLs (`isMixedRoutes`); each route opens with its own transport
  (`mixedOpen`: `rtc:lianki` through `publicOpen`, the rest a plain socket
  with its ticket) and his device, thread and filter go along on all of
  them. The race's deadline is the public one (6 s: session, signalling,
  ICE). `/api/stt/session` still needs flag `stt.worker` and his account on
  `/dev/stt-access`. A mixed list does not report usage from the page
  (`reportLocalStt`): the registry books the WebRTC route's minutes. The
  stored value (`lk:agent-local-stt`) keeps the names `rtc:lianki` /
  `wss:session` only for the chat mic (`localSttRoute(…, named)`); until
  2026-11-11 they were dropped as non-URLs, so a mixed list never reached
  WebRTC. vibe and the /words mic open plain sockets and still drop them.
- **Comparing**: `rtc:lianki` alone vs the tailnet URL alone on the same
  phone, read from the devLog (`local-stt-final {firstPartialMs,
endToFinalMs}`, `stt-route`).

## WebRTC

The owner's own route still does not use it. The phone already reaches the
Mac over the tailnet, and a WebSocket of 16 kHz int16 is 32 KB/s, small next
to any uplink. WebRTC would add Opus compression and a jitter buffer, at the
cost of signalling through the push hub and ICE; it would help only on a poor
connection, where the fallback already covers the failure case. For other
accounts (no tailnet) it is the first route: a DataChannel carrying the same
protocol, through the `stt-peer` sidecar ("Lianki's speech servers for
everyone" above), not aiortc.

## Testing

- `unit/local-stt.test.ts`: the client against a fake WebSocket (frames,
  partials, pre-pad, final timings, drop, timeout, error, cancel); "an
  utterance begun while the socket is down" (held then streamed in order, an
  end before ready, opening failing to the cloud, cancel while held, the
  steady state unchanged); "reopening while the mic is on" (close, visible,
  online, a dead socket without its onclose, a hidden page, the backoff with
  one deferred attempt per event, the stable reset, close() unwatching); "the
  browser's close code".
- `unit/wake.test.ts`, "the rest after Linky streams to the local STT when
  its socket is up"; `unit/mic.test.ts` and `unit/mic-session.test.ts`: mic
  on and off keep and release the socket; `unit/agent-keys.test.ts`: the
  stale-key cases.
- `unit/mic.test.ts`, "streaming to the local STT": the mic streams instead of
  chunking, shows the partials, hands the final over, cancels on misfire and
  hold.
- `unit/local-stt-server.test.ts`: the real server with a saved clip; runs
  only where the venv, the model and the clips are (skipped in CI).
- `unit/local-stt.test.ts`, "racing the tailnet and the tunnel": the stagger,
  the ticket as a subprotocol, the winner kept and the loser closed, a
  failure starting the next URL at once, all failing to the cloud, the
  deadline, tickets only to `TICKET_HOSTS`.
- `unit/stt-ticket.test.ts`: signing and verifying (expiry, replay, wrong
  aud, wrong key, an edited payload, a long-lived ticket).
- `unit/local-stt-gate.test.ts`: the tunnel listener of the real server
  (`--engine fake`, no model) refusing before the upgrade — no ticket, a wrong
  Origin, another key, expired, wrong aud, a replay, a third socket, no
  `/health` — and admitting a good ticket; a taken tunnel port leaving the
  tailnet listener up; `public.json` turning it on with the key it names, and
  a missing key keeping it off. It runs `scripts/local-stt/test_ticket.py`
  too (including the full ticket store recovering once its jtis expire). Skipped where the venv (with `cryptography`) is missing.
- Lianki's speech servers for everyone: `unit/stt-ticket.test.ts` (v2),
  `unit/stt-worker-store.test.ts`, `unit/stt-session.test.ts`,
  `unit/stt-registry.test.ts` (the registry, its routes' 404 while off, the
  RPCs, the add CLI), `unit/local-stt-peer.test.ts` (the real server's peer
  listener: v2 only, the limits, no voiceprint features; venv only) and
  `unit/stt-peer-go.test.ts` (`go test`: a page reaching a fake speech
  server over a real DataChannel through stt-peer; where Go is installed).
- `unit/stt-tunnel.test.ts`: `tunnel.sh up` and `down` against stand-ins for
  oxmgr, cloudflared and curl: the oxmgr entry left exactly as it was, the
  custom key path reaching the server, and the restore when the listener
  fails to start, `/health` fails, or the server never says "listening".
- `scripts/local-stt/test_voiceprint.py`, `FilterLineTest` and the filter's
  server tests: stops only a clear mismatch on this device's own print; passes
  a short, noisy or unprinted one; holds partials; off is exactly as before.
  `unit/voiceprint.test.ts`, "the voiceprint filter on the page": a stopped
  final goes nowhere, the tally, the switch, every failure reading as off.
- `unit/voiceprint-window.test.ts`: the passkey window (expiry, config
  shortening, per-op single use, another account / session / device refused,
  no grant → the prompt), the test mode, and the print delete keeping the
  Mac's recordings until their own tap; `test_voiceprint.py`
  `test_deleting_the_print_keeps_the_recordings` and
  `test_delete_keeps_recordings_until_asked` on the Mac's side.
- `unit/voiceprint.test.ts`: the page's side of the voiceprint: consent
  gating (nothing captured or started on the Mac before the tap), reading
  and its "again" reasons, save at 10 and by itself at 20, cancel, delete
  only after the confirming tap; the mic routing enrolment sentences to the
  Mac only; passive mode dropping "other" (a count in the log, no text);
  the tag on voice lines; the socket's hello, `enrol`, `textFrom` and
  requests; the hub's parser.
- `unit/local-stt-voiceprint.test.ts` runs `scripts/local-stt/test_voiceprint.py`
  with the venv: the bands and the noise gate, the store's modes (0700 /
  0600 under a 000 umask, symlinks and loose modes refused), delete (one
  device, all, never a clips folder beside it), the CLI, enrolment checks,
  and the real server (`--engine fake --speaker fake`) end to end over
  WebSocket. Synthetic tones in temp folders; skipped in CI.
- `bun scripts/dev/voiceprint-qa.mjs [--shots <dir>]`: the panel in a
  silent browser on `/harness` against that fake server: the consent card
  (the path, keep-audio off), no microphone and no enrolment on the Mac
  before the tap, the tap opening it, a refused mic dropping it, and the
  verified mark on "me" lines only; light and dark at 390 px.
- `scripts/local-stt/voiceprint-bench.py`: the latency table above (a COPY
  of the clips, a throwaway print in a temp folder, niced, waits while he
  talks).
- `unit/local-stt-lang-pick.test.ts` runs `scripts/local-stt/test_lang_pick.py`
  with the venv: the pick rule, `final()` with stubs, the filterbank, and the
  int8 scorer when the model is there (skipped in CI).
- By hand: `bun scripts/local-stt/stream-clip.ts --url ws://127.0.0.1:5193`
  streams every saved clip at real-time pace and prints partials and timings;
  `python -I scripts/local-stt/bench.py` is the whole-clip A/B above;
  `noisy.py <dir>` then `bench-noise.py [--atten 10]` the noise table;
  `ab-eval.py` the streaming / endpoint / AEC A/B and the field metrics;
  `grid-eval.py` and `speaker-grid.py` the noise / VAD / gain grid and the
  speaker check, niced and pausing while he talks ([stt-ab.md](stt-ab.md)).
- `server.py` logs each connection, each final (length and decode time,
  never the text) and every refused handshake (a wrong Origin) through the
  `websockets` logger.

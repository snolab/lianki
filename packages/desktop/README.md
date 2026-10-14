# @lianki/desktop — Windows desktop shell

A [Tauri 2](https://v2.tauri.app) window around **https://lianki.com**. It is
a shell, not a port: the Next.js server (route handlers, better-auth, D1)
cannot be bundled into a desktop binary, so the window loads the hosted site
over WebView2 and the site's own service worker (`public/sw.js`) covers the
offline fallback. Nothing from the page can call into Rust — no IPC is
exposed.

Why Tauri and not Electron: WebView2 is already on every Windows 10/11
machine, so the installer is a few MB and idle memory is a fraction of a
bundled Chromium. The research behind the choice is in the 2026-10-13 session
notes (PWA first, Tauri shell second, static-export client only if true
offline review is ever needed).

## What the shell does

| Behaviour | Where |
| --- | --- |
| Loads `https://lianki.com/list` — the app, not the landing page (override with `LIANKI_URL`) | `src-tauri/src/lib.rs` `start_url` |
| Keeps `lianki.com`, `www.lianki.com`, Google and GitHub OAuth hosts in-app; every other link opens in the default browser | `is_in_app_host` / `allow_navigation` |
| Turns `target="_blank"` / `window.open` into same-window navigation so the rule above applies | `INIT_SCRIPT` |
| One instance: launching again focuses the existing window | `tauri-plugin-single-instance` |
| Remembers window size/position | `tauri-plugin-window-state` |

The OAuth hosts are allow-listed on purpose: social sign-in redirects through
`accounts.google.com` / `github.com` and back to `/api/auth/callback/*`. If
that hop went to the system browser, the session cookie would land there
instead of in the app.

## Commands

Prerequisites: Rust stable (`rustup`), Bun, and the WebView2 runtime (present
on Windows 10/11; the installer fetches it if missing).

```bash
cd packages/desktop
bun run dev                                        # window on https://lianki.com/list
LIANKI_URL=http://localhost:3000/list bun run dev  # against `bun run dev` in the repo root
bun run check                                 # cargo check only
bun run build                                 # NSIS installer → src-tauri/target/release/bundle/nsis/
```

PowerShell: `$env:LIANKI_URL = "http://localhost:3000/list"; bun run dev`.

## Config notes

- `src-tauri/tauri.conf.json` — `app.windows` is empty because the window is
  built in Rust (that is the only way to attach `on_navigation`). The
  `frontendDist` placeholder in `dist/` is required by the bundler but never
  shown.
- WebView2 install mode is `downloadBootstrapper` (0 MB extra). Do not switch
  to `offlineInstaller` or `fixedRuntime` without a reason — they add ~127 MB
  and ~180 MB respectively.
- Installer is NSIS, per-user (`currentUser`), so no admin prompt.
- Icons were generated with `tauri icon` from the 256 px frame of
  `app/favicon.ico`. Regenerate the same way if the favicon changes.
- Keep `tauri` at 2.10.3 or newer: CVE-2026-42184 (origin confusion in the
  `http://<scheme>.localhost` mapping on Windows) was fixed there.

## Known gaps

- **Magic-link sign-in** opens the emailed link in the user's browser, not in
  the app. Use Google or GitHub sign-in inside the app, or add a deep-link
  handler (`tauri-plugin-deep-link`) later.
- **Google OAuth in embedded webviews** is blocked by user-agent on some
  engines. WebView2 presents an Edge user agent and is expected to pass;
  verify once on a signed-out machine before announcing the app.
- **Not signed.** Windows SmartScreen will warn on first run until the
  installer is code-signed (see Tauri's Windows signing guide).
- **No auto-update yet.** `tauri-plugin-updater` needs a signing keypair and a
  hosted `latest.json`; add it when there is a release channel.
- The userscript / extension still do the on-page work on YouTube and other
  sites; the desktop app only covers the lianki.com surface.

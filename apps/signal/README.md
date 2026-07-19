# lianki-signal

WebRTC **signaling** relay for Lianki P2P card sync — deploys to **s.lianki.com**.

- `SignalRoom` Durable Object = one per room (a hashed shared secret). Relays the
  WebRTC handshake (offer/answer/ICE) between peers over hibernatable WebSockets.
- Card data never touches this server — once peers connect, decks flow over a P2P
  RTCDataChannel (see `apps/web/src/lib/webrtcSync.ts` + the `/sync` page).

```bash
bun run --filter='lianki-signal' deploy   # first deploy → *.workers.dev
# then attach the custom domain s.lianki.com (dashboard: Workers → lianki-signal
# → Settings → Domains & Routes → Custom Domain → s.lianki.com), or a route.
```

Endpoints: `GET /health`, `GET /signal?room=<key>` (WebSocket upgrade).

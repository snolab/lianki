/**
 * qa-partner-embed.ts fixture: the frame's side, with the real guest
 * protocol (frame-guest.ts) standing in for /embed/partner: it asks for a
 * ticket and puts it on its own body (only the test reads the frame).
 */
import { startFrameGuest } from "../../packages/debug-chat/src/embed/frame-guest";

startFrameGuest(window, (g) => {
  void g.ticket().then((t) => {
    document.body.dataset.ticket = t ?? "";
  });
  g.size(320, 200);
});

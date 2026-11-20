/**
 * qa-partner-embed.ts / qa-pill-chat.ts fixture: the frame's side, with the
 * real guest protocol (frame-guest.ts) standing in for /embed/partner: it asks
 * for a ticket and puts it on its own body (only the test reads the frame).
 * When the frame page has Share buttons (qa-pill-chat.ts, M3), a trusted press
 * on one asks the shell for that share and puts the answer on the body too.
 */
import { startFrameGuest } from "../../packages/debug-chat/src/embed/frame-guest";

startFrameGuest(window, (g) => {
  void g.ticket().then((t) => {
    document.body.dataset.ticket = t ?? "";
  });
  g.size(320, 200);
  for (const what of ["page", "selection"] as const)
    document.getElementById(`share-${what}`)?.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      void g.share(what).then((p) => {
        document.body.dataset[`share${what === "page" ? "Page" : "Selection"}`] = JSON.stringify(p);
      });
    });
});

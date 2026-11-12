// The page side of qa-smart-refresh.ts: the real VersionNotice, mounted at a
// path the test sets (window.__nav, as Next's soft navigation would), with the
// socket's messages recorded so the test knows each one has arrived.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { VersionNotice } from "@/app/components/VersionNotice";

const w = window as unknown as {
  __msgs: string[];
  __nav: (p: string) => void;
  __unmountNotice: () => void;
  __versionSockets: WebSocket[];
  WebSocket: typeof WebSocket;
};
w.__msgs = [];
w.__versionSockets = [];
const Real = w.WebSocket;
w.WebSocket = class extends Real {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    w.__versionSockets.push(this);
    this.addEventListener("message", (e) => w.__msgs.push(String(e.data)));
  }
};

function Page() {
  const [path, setPath] = useState(location.pathname);
  const [mounted, setMounted] = useState(true);
  w.__unmountNotice = () => setMounted(false);
  w.__nav = (p) => {
    history.pushState(null, "", p);
    setPath(p);
  };
  return mounted ? (
    <VersionNotice pathname={path} autoUpdate={new URLSearchParams(location.search).has("auto")} />
  ) : null;
}

createRoot(document.getElementById("root")!).render(<Page />);

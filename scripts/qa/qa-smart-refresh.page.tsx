// The page side of qa-smart-refresh.ts: the real VersionNotice, mounted at a
// path the test sets (window.__nav, as Next's soft navigation would), with the
// socket's messages recorded so the test knows each one has arrived.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { VersionNotice } from "@/app/components/VersionNotice";

const w = window as unknown as {
  __msgs: string[];
  __nav: (p: string) => void;
  WebSocket: typeof WebSocket;
};
w.__msgs = [];
const Real = w.WebSocket;
w.WebSocket = class extends Real {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("message", (e) => w.__msgs.push(String(e.data)));
  }
};

function Page() {
  const [path, setPath] = useState(location.pathname);
  w.__nav = (p) => {
    history.pushState(null, "", p);
    setPath(p);
  };
  return <VersionNotice pathname={path} />;
}

createRoot(document.getElementById("root")!).render(<Page />);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "@lianki/web";

// The Worker serves the @lianki/web SPA (single origin, no CORS). This client
// bundle ships as Workers Static Assets — it doesn't count against the 3 MiB
// worker-script limit.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

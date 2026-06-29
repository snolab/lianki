import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// Vite builds the React client; @cloudflare/vite-plugin builds the Worker and
// wires Static Assets + bindings from wrangler.jsonc. `vite build` then
// `wrangler deploy` ships both.
export default defineConfig({
  plugins: [react(), cloudflare()],
});

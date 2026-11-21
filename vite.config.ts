import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web app builds into dist/, which the Worker serves as static assets.
// `npm run dev:web` gives hot reload on :5173 and forwards API calls to `wrangler dev` on :8787.
const worker = "http://localhost:8787";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    proxy: {
      "/api": { target: worker, ws: true },
      "/login": worker,
      "/logout": worker,
      "/auth": worker,
    },
  },
});

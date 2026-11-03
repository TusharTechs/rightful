import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web app lives in web/ and shares the ledger code (src/claims/ledger.ts, src/engine) with the
// API, so the browser verifies payouts and the audit with exactly the code the server ran.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5173 },
});

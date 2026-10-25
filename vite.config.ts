import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The fan app lives in web/ and shares the ballot engine (src/ballot) with the API, so the browser
// verifies proofs and draws with exactly the code the server ran.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5173 },
});

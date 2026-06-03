import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  build: {
    chunkSizeWarningLimit: 1200,
  },
  // IPv4 explícito + puerto fijo: evita que `fetch` desde Node falle por ::1 / host distinto al del IDE.
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});

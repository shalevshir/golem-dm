import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A dev proxy rather than CORS middleware on the server: it needs no server
 * change and adds no cross-origin surface to an API that has no auth. The
 * client therefore always talks to same-origin relative paths, in dev and in
 * a built deployment alike.
 */
export default defineConfig({
  server: {
    proxy: {
      "/sessions": "http://localhost:3000",
      "/encounters": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
  plugins: [react()],
});

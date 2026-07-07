import { defineConfig } from "vite";

// getUserMedia needs a secure context: localhost is fine as-is; if the
// robot's display opens this over the LAN, serve HTTPS or use a tunnel.
export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
});

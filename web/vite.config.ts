import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // UNO development traffic must never reach the existing finance service.
    proxy: { "/api": {
      target: "http://127.0.0.1:3093",
      changeOrigin: true,
      configure(proxy) {
        proxy.on("proxyReq", (request) => {
          request.setHeader("origin", "http://127.0.0.1:3093");
          request.setHeader("referer", "http://127.0.0.1:3093/");
        });
      },
    } },
  },
  preview: { host: "127.0.0.1" },
});

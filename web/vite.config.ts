import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // dev 下 /api 代理到本地服务器（SSE 不缓冲）
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});

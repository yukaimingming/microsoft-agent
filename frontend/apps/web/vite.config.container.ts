import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn / AI Elements 组件使用 @/ 别名。
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5175,
    // 本地开发：前端只连本机服务端，不开局域网访问。
    host: "0.0.0.0",
    proxy: {
      // 服务端 API 与 AG-UI 端点都通过代理转发，避免 CORS 与端口硬编码。
      "/api": {
        target: "http://host.docker.internal:8788",
        changeOrigin: false,
      },
      "/agent": {
        target: "http://host.docker.internal:8788",
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 5176,
    host: "0.0.0.0",
    proxy: {
      "/api": { target: "http://host.docker.internal:8788", changeOrigin: false },
      "/agent": { target: "http://host.docker.internal:8788", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});

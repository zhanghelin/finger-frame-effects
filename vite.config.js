import { defineConfig } from "vite";

// 平台部署约定：主进程监听容器内 8000 端口
export default defineConfig({
  server: {
    port: 8000,
    host: true,
  },
  preview: {
    port: 8000,
    host: true,
  },
  build: {
    // vendor/ 内的 MediaPipe 模型与 wasm 较大，提高单文件警告阈值
    chunkSizeWarningLimit: 12000,
  },
});

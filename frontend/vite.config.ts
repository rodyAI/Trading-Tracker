import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(__dirname, ".."),
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared/src"),
    },
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    open: true,
  },
});

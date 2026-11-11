import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// OutLayer's job list sends no CORS header, so the app reaches it through its
// own origin. vercel.json does the same forwarding on the live site.
const jobs = (host: string) => ({ target: `https://${host}`, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/outlayer\/\w+\/jobs/, "/public/jobs") });

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      "/outlayer/testnet/jobs": jobs("testnet-api.outlayer.ai"),
      "/outlayer/mainnet/jobs": jobs("api.outlayer.ai"),
    },
  },
});

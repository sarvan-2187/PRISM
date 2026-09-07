import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // shadcn/ui components import each other as "@/components/ui/...".
    // Mirrors the paths entry already in tsconfig.json.
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // WebAuthn requires a secure context. localhost counts, so the demo runs
    // here without TLS. Do not change this hostname after registering a
    // passkey: the RP ID is bound to it and every credential would break.
    port: 5173,
    strictPort: true,
  },
});

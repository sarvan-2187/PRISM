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
    port: 5173,
    strictPort: true,

    // Bind 0.0.0.0 so the LAN and any tunnel can reach the dev server.
    host: true,

    // Vite 5.4.12+ rejects requests whose Host header it does not recognise
    // with a bare "Blocked request. This host is not allowed." Tunnel
    // hostnames are random, so the domains have to be allowed by suffix.
    allowedHosts: ['.trycloudflare.com', '.loca.lt', '.ngrok-free.app', '.ngrok.io'],

    /*
     * Proxy the API through this same server.
     *
     * This is what makes remote access work at all. One origin means the
     * browser never makes a cross-site request, so the backend's CORS rule
     * and the `sameSite: 'lax'` session cookie both keep working untouched,
     * and VITE_API_URL stops mattering: a visitor's browser no longer tries
     * to reach "localhost:4000" on their own machine.
     */
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
      '/health': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
});

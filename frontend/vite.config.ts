import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/*
 * HTTPS is opt-in by the presence of the cert files, so a teammate who has
 * never run mkcert still gets a working plain-HTTP dev server on localhost.
 * Generate them with:  cd certs && ./mkcert.exe -install && ./mkcert.exe prism.local
 */
const certDir = path.resolve(__dirname, '../certs');
const keyPath = path.join(certDir, 'prism.local-key.pem');
const certPath = path.join(certDir, 'prism.local.pem');
const hasCert = fs.existsSync(keyPath) && fs.existsSync(certPath);

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

    /*
     * WebAuthn only runs in a secure context, and `rpId` must be a domain
     * rather than an IP. Serving this hostname over a locally-trusted cert
     * satisfies both, which is what makes real passkeys work across laptops
     * without any Chrome flags. See docs/LAN_DEMO_SETUP.md.
     */
    ...(hasCert
      ? { https: { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } }
      : {}),

    // Vite 5.4.12+ rejects requests whose Host header it does not recognise,
    // answering 403 before any route runs. Tunnel hostnames are random, so
    // those domains are allowed by suffix; `.local` covers the LAN demo
    // hostname. An IP in the Host header is always permitted by Vite.
    allowedHosts: [
      '.trycloudflare.com',
      '.loca.lt',
      '.ngrok-free.app',
      '.ngrok.io',
      '.local',
      'prism.local',
    ],

    /*
     * Proxy the API through this same server.
     *
     * This is what makes remote access work. One origin means the browser
     * never makes a cross-site request, so the backend's CORS rule and the
     * `sameSite: 'lax'` session cookie both keep working untouched, and the
     * backend needs no TLS of its own: this hop is loopback HTTP.
     *
     * It is also why VITE_API_URL must stay empty. Pointing it at
     * https://prism.local:4000 would bypass all of the above.
     */
    proxy: {
      // xfwd adds X-Forwarded-For with the real client IP. Without it every
      // laptop reaches the backend as 127.0.0.1 and they all share one
      // rate-limit bucket. Paired with app.set('trust proxy', 1) in
      // backend/src/index.ts.
      '/api': { target: 'http://localhost:4000', changeOrigin: false, xfwd: true },
      '/health': { target: 'http://localhost:4000', changeOrigin: false, xfwd: true },
    },
  },
});

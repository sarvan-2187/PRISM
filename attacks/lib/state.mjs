/**
 * Shared state file written by setup/provision.mjs and read by every attack
 * script: session cookies for the two seeded demo users and any live
 * transaction/QR ids the attacks need as a starting point.
 *
 * Never committed (see attacks/.gitignore) — it holds session cookies for a
 * local dev instance, not secrets that matter beyond this machine.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', '.state.json');

export function loadState() {
  if (!existsSync(STATE_PATH)) {
    throw new Error(
      `No ${STATE_PATH} found. Run "npm run setup" first — it registers/logs in the ` +
        `seeded demo accounts via a real WebAuthn ceremony and saves their session cookies.`
    );
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Runs every attack script in order and prints a summary matrix.
 * Exits non-zero if any script reports a VULNERABILITY or ERROR.
 *
 * The three ~65-95s clock-based attacks (03, 06) make a full run take a few
 * minutes — that's inherent to testing a real expiry window honestly, not a
 * bug in the harness. Run individual scripts (npm run attack:tamper, etc.)
 * during iteration.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 08-rate-limit-bruteforce deliberately trips the strict rate limiter, which
// is shared (by client IP) across every /auth/* and /payment/:id/step-up
// route. It must run LAST — 10-semantic-stepup-bruteforce needs a fresh
// register/login through that same limiter and will get RATE_LIMITED if 08
// has just exhausted the window.
const ATTACKS = [
  '01-transaction-tampering',
  '02-replay-settled-transaction',
  '07-idor-cross-user',
  '04-qr-forged-signature',
  '05-qr-replay',
  '09-session-jwt-tamper',
  '03-expired-intent',
  '06-qr-expired',
  '10-semantic-stepup-bruteforce',
  '08-rate-limit-bruteforce',
];

function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, dir, 'attack.mjs')], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 2));
  });
}

async function main() {
  const results = [];
  for (const dir of ATTACKS) {
    console.log(`\n${'='.repeat(70)}`);
    const code = await run(dir);
    results.push({ dir, code });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY');
  console.log('='.repeat(70));
  const label = (c) => (c === 0 ? 'PASS/BLOCKED' : c === 1 ? 'VULNERABILITY' : 'ERROR/SKIPPED-CHECK-LOG');
  for (const r of results) {
    console.log(`  ${r.code === 0 ? 'OK ' : '!! '} ${r.dir.padEnd(32)} ${label(r.code)}`);
  }

  const anyVuln = results.some((r) => r.code === 1);
  process.exitCode = anyVuln ? 1 : 0;
}

main();

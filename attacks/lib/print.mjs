/**
 * Shared console output for attack scripts.
 * Keeps every script's output in the same shape so results are easy to scan
 * during a live demo and easy to diff in CI.
 */

export function section(name) {
  console.log(`\n[ATTACK] ${name}`);
}

export function target(method, path) {
  console.log(`[TARGET] ${method} ${path}`);
}

export function step(msg) {
  console.log(`[+] ${msg}`);
}

export function info(msg) {
  console.log(`    ${msg}`);
}

export function pass(reason) {
  console.log(`[PASS] Server rejected the attack as designed.`);
  if (reason) console.log(`Reason: ${reason}`);
}

export function fail(msg) {
  console.log(`[FAIL] ${msg}`);
}

export function vulnerability(msg) {
  console.log(`\n[VULNERABILITY] ${msg}`);
}

export function skipped(reason) {
  console.log(`[SKIPPED] ${reason}`);
}

/**
 * Standard exit: 0 = attack was blocked (secure), 1 = vulnerability found,
 * 2 = the script itself could not complete (bad precondition, server down).
 */
export function finish(outcome) {
  const code = { PASS: 0, VULNERABILITY: 1, ERROR: 2, SKIPPED: 0 }[outcome];
  process.exitCode = code;
}

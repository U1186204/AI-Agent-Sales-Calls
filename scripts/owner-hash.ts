/**
 * Print an OWNER_PASSWORD_HASH for a password.
 *
 *   npm run owner:hash                       (prompts; the passphrase stays out of shell history)
 *   npm run owner:hash -- "my long passphrase"
 *
 * Paste the output into .env as OWNER_PASSWORD_HASH=... The password itself is never written
 * to disk by this script.
 */
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/auth/password";

async function readPassword(): Promise<string> {
  const arg = process.argv[2];
  if (arg) return arg;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Owner passphrase: ")).trim();
  // Ask twice when typing interactively so a typo can't lock the owner out.
  if (answer && process.stdin.isTTY) {
    const again = (await rl.question("Repeat passphrase: ")).trim();
    if (again !== answer) {
      rl.close();
      console.error("Passphrases don't match. Nothing was printed; run it again.");
      process.exit(2);
    }
  }
  rl.close();
  return answer;
}

const password = await readPassword();
if (!password) {
  console.error('Usage: npm run owner:hash   (or: npm run owner:hash -- "<password>")');
  process.exit(2);
}
if (password.length < 12) {
  console.error("Warning: use at least 12 characters for a real deployment.");
}
const hash = await hashPassword(password);
// Next.js expands `$VAR` inside .env files, so the .env line escapes each `$`.
const escaped = hash.split("$").join("\\$");
console.log(`# Paste into .env:`);
console.log(`OWNER_PASSWORD_HASH=${escaped}`);
console.log(`# Raw value (for host dashboards / docker env, no escaping):`);
console.log(hash);

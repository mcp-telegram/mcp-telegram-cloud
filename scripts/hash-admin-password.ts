// Usage: bun scripts/hash-admin-password.ts
// Prompts for a password, prints the ADMIN_PASSWORD_HASH value to put in .env.
// Never run this against a password you want to keep off your terminal
// scrollback in a shared environment — use a local machine.
import { createInterface } from "node:readline/promises";
import { hashAdminPassword } from "../src/auth/admin.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Admin password to hash: ");
rl.close();

if (!password) {
  console.error("No password entered.");
  process.exit(1);
}

console.log(`\nADMIN_PASSWORD_HASH=${hashAdminPassword(password)}`);

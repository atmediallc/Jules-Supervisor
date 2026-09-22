#!/usr/bin/env node
/**
 * CLI tool for rotating the SETTINGS_ENCRYPTION_KEY across all secret settings in PostgreSQL.
 *
 * Usage:
 *   OLD_KEY="old" NEW_KEY="new" node packages/db/dist/rotate-key.js
 *   or:
 *   pnpm --filter @jules/db rotate-key <old_key> <new_key>
 */
import { getDatabase, SystemSettingsRepository } from "./index.js";

async function main() {
  const oldKey = process.argv[2] || process.env.OLD_SETTINGS_ENCRYPTION_KEY || process.env.OLD_KEY;
  const newKey = process.argv[3] || process.env.NEW_SETTINGS_ENCRYPTION_KEY || process.env.NEW_KEY;

  if (!oldKey || !newKey) {
    console.error("Usage: rotate-key <old_key> <new_key>");
    console.error("Or set OLD_SETTINGS_ENCRYPTION_KEY and NEW_SETTINGS_ENCRYPTION_KEY env vars.");
    process.exit(1);
  }

  const databaseUrl =
    process.env.DATABASE_URL ||
    "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

  console.log("Connecting to database for key rotation...");
  const db = getDatabase(databaseUrl);
  const repo = new SystemSettingsRepository(db);

  try {
    console.log("Rotating secrets...");
    const rotated = await repo.rotateEncryptionKey(oldKey, newKey);
    console.log(`Successfully rotated ${rotated} secret setting(s).`);
    process.exit(0);
  } catch (err) {
    console.error("Key rotation failed! Database records were preserved.", (err as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error during rotation:", err);
  process.exit(1);
});

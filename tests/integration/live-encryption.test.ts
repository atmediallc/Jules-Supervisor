/**
 * Live settings-at-rest test.
 *
 * Documents how the SystemSettingsRepository currently stores values, including
 * secret values, in PostgreSQL. If the storage format changes (e.g. to an
 * encrypted ciphertext envelope), this test must be updated to match.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { SystemSettingsRepository } from "../../packages/db/src/repositories/system-settings.repository";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);
const settingsRepo = new SystemSettingsRepository(db);

const SECRET_KEY = "test_secret_round_trip_live";

beforeAll(async () => {
  await client.connect();
  await client
    .query(`DELETE FROM system_settings WHERE key = $1`, [SECRET_KEY])
    .catch(() => undefined);
});

afterAll(async () => {
  try {
    await client.query(`DELETE FROM system_settings WHERE key = $1`, [SECRET_KEY]);
  } catch {
    // best-effort
  }
  await client.end();
});

describe("Live settings at rest", () => {
  it("Round-trips a secret value and persists in plaintext to PostgreSQL", async () => {
    const SECRET_VALUE = "sk-live-1234567890-abcdef";
    await settingsRepo.upsert({
      key: SECRET_KEY,
      value: SECRET_VALUE,
      category: "infrastructure",
      isSecret: true,
      description: "round-trip test",
    });

    const got = await settingsRepo.getByKey(SECRET_KEY);
    expect(got).toBeDefined();
    expect(got!.value).toBe(SECRET_VALUE);

    // Verify the row physically contains the plaintext in the DB
    const raw = await client.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [SECRET_KEY],
    );
    expect(raw.rows[0]?.value).toBe(SECRET_VALUE);
  });

  it("Setting categories and flags are persisted", async () => {
    const KEY = "test_category_round_trip_live";
    await settingsRepo.upsert({
      key: KEY,
      value: "v",
      category: "observability",
      isSecret: false,
      description: "category test",
    });
    const map = await settingsRepo.getAsMap();
    expect(map[KEY]).toBe("v");
    await client.query(`DELETE FROM system_settings WHERE key = $1`, [KEY]);
  });
});

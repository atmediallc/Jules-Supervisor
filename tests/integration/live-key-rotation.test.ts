/**
 * Live PostgreSQL Key Rotation Integration Tests.
 *
 * Verifies S04:
 * 1. Encrypts multiple secret rows under Key A.
 * 2. Rotates to Key B.
 * 3. Proves raw ciphertext changes and is now decodable under Key B.
 * 4. Proves Key A no longer decodes current rows.
 * 5. Proves failure halfway preserves original uncorrupted data.
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
const repo = new SystemSettingsRepository(db);

const KEY_A = "rotation-key-a-32-chars-long-001";
const KEY_B = "rotation-key-b-32-chars-long-002";
const SECRET_1 = "test_rot_sec_1";
const SECRET_2 = "test_rot_sec_2";
const VAL_1 = "super-secret-payload-one";
const VAL_2 = "super-secret-payload-two";

const originalEnvKey = process.env.SETTINGS_ENCRYPTION_KEY;

beforeAll(async () => {
  await client.connect();
  // Ensure table is clean of any concurrent test rows that might use a different key
  await client.query(`DELETE FROM system_settings WHERE is_secret = true`).catch(() => undefined);
});

afterAll(async () => {
  if (originalEnvKey !== undefined) {
    process.env.SETTINGS_ENCRYPTION_KEY = originalEnvKey;
  } else {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
  }
  try {
    await client.query(`DELETE FROM system_settings WHERE is_secret = true`);
  } catch {
    // best-effort
  }
  await client.end();
});

describe("Live Key Rotation (S04)", () => {
  it("rotates secrets from Key A to Key B atomically", async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_A;
    await repo.upsert({
      key: SECRET_1,
      value: VAL_1,
      category: "infrastructure",
      isSecret: true,
      description: "rot test 1",
    });
    await repo.upsert({
      key: SECRET_2,
      value: VAL_2,
      category: "infrastructure",
      isSecret: true,
      description: "rot test 2",
    });

    const rawBefore1 = (await client.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [SECRET_1])).rows[0]!.value;
    const rawBefore2 = (await client.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [SECRET_2])).rows[0]!.value;

    expect(rawBefore1.startsWith("enc:v1:")).toBe(true);
    expect(rawBefore2.startsWith("enc:v1:")).toBe(true);

    // Execute key rotation
    const rotated = await repo.rotateEncryptionKey(KEY_A, KEY_B);
    expect(rotated).toBeGreaterThanOrEqual(2);

    // Raw ciphertexts changed
    const rawAfter1 = (await client.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [SECRET_1])).rows[0]!.value;
    const rawAfter2 = (await client.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [SECRET_2])).rows[0]!.value;

    expect(rawAfter1).not.toBe(rawBefore1);
    expect(rawAfter2).not.toBe(rawBefore2);

    // Key B can decrypt
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_B;
    const got1 = await repo.getByKey(SECRET_1);
    const got2 = await repo.getByKey(SECRET_2);

    expect(got1!.value).toBe(VAL_1);
    expect(got2!.value).toBe(VAL_2);

    // Key A now FAILS to decrypt
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_A;
    await expect(repo.getByKey(SECRET_1)).rejects.toThrow();
    await expect(repo.getByKey(SECRET_2)).rejects.toThrow();

    // Restore to Key B
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_B;
  });

  it("fails safely if rotation encounters wrong initial key", async () => {
    // Attempting rotation with wrong old key throws and leaves data intact
    await expect(repo.rotateEncryptionKey("wrong-old-key-here-32-chars-long", "new-key-32-chars-long")).rejects.toThrow();

    // Data under Key B is still intact
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_B;
    const got1 = await repo.getByKey(SECRET_1);
    expect(got1!.value).toBe(VAL_1);
  });
});

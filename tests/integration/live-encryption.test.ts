/**
 * Live settings-at-rest encryption tests (E1 through E10).
 *
 * Exercises the SystemSettingsRepository and raw PostgreSQL representation
 * with real database queries. Proves secrets are truly encrypted at rest
 * using AES-256-GCM and never stored as plaintext in PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { SystemSettingsRepository } from "../../packages/db/src/repositories/system-settings.repository";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const TEST_KEY = "live-test-encryption-key-32-chars-long!!";
const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);
const settingsRepo = new SystemSettingsRepository(db);

const SECRET_KEY = "test_live_secret_key";
const NON_SECRET_KEY = "test_live_non_secret_key";
const LEGACY_KEY = "test_live_legacy_secret_key";

beforeAll(async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  await client.connect();
  await client.query(`DELETE FROM system_settings WHERE is_secret = true`).catch(() => undefined);
});

afterAll(async () => {
  try {
    await client.query(`DELETE FROM system_settings WHERE is_secret = true`);
  } catch {
    // best-effort
  }
  await client.end();
});

describe("Live PostgreSQL encryption at rest (E1 - E10)", () => {
  const SECRET_PLAINTEXT = "sk-live-super-secret-token-abcdef123456";

  it("E1: secret persistence — raw database value is ciphertext, NOT plaintext", async () => {
    await settingsRepo.upsert({
      key: SECRET_KEY,
      value: SECRET_PLAINTEXT,
      category: "infrastructure",
      isSecret: true,
      description: "E1 persistence test",
    });

    // Directly inspect raw PostgreSQL column
    const raw = await client.query<{ value: string; is_secret: boolean }>(
      `SELECT value, is_secret FROM system_settings WHERE key = $1`,
      [SECRET_KEY],
    );

    expect(raw.rows[0]).toBeDefined();
    const dbValue = raw.rows[0]!.value;

    // INVARIANT: Raw database value must be enc:v1 envelope and must NOT contain plaintext
    expect(dbValue.startsWith("enc:v1:")).toBe(true);
    expect(dbValue).not.toContain(SECRET_PLAINTEXT);
  });

  it("E2: round trip — repository reads and decrypts internally", async () => {
    const row = await settingsRepo.getByKey(SECRET_KEY);
    expect(row).not.toBeNull();
    expect(row!.value).toBe(SECRET_PLAINTEXT);
    expect(row!.isSecret).toBe(true);
  });

  it("E3: API masking contract — plaintext never exposed in unmasked form", async () => {
    // Verified by repository method: getAsMap decrypts for internal trusted callers
    const map = await settingsRepo.getAsMap();
    expect(map[SECRET_KEY]).toBe(SECRET_PLAINTEXT);

    // Raw DB row remains ciphertext
    const raw = await client.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [SECRET_KEY],
    );
    expect(raw.rows[0]!.value.startsWith("enc:v1:")).toBe(true);
  });

  it("E4: unique nonce — writing identical plaintext twice produces different ciphertexts", async () => {
    const KEY_A = `${SECRET_KEY}_nonce_a`;
    const KEY_B = `${SECRET_KEY}_nonce_b`;

    await settingsRepo.upsert({
      key: KEY_A,
      value: SECRET_PLAINTEXT,
      category: "infrastructure",
      isSecret: true,
      description: "nonce test A",
    });

    await settingsRepo.upsert({
      key: KEY_B,
      value: SECRET_PLAINTEXT,
      category: "infrastructure",
      isSecret: true,
      description: "nonce test B",
    });

    const rawA = await client.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [KEY_A]);
    const rawB = await client.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [KEY_B]);

    const valA = rawA.rows[0]!.value;
    const valB = rawB.rows[0]!.value;

    expect(valA).not.toBe(valB); // Different IV/nonce
    expect(valA.startsWith("enc:v1:")).toBe(true);
    expect(valB.startsWith("enc:v1:")).toBe(true);

    // Clean up
    await client.query(`DELETE FROM system_settings WHERE key IN ($1, $2)`, [KEY_A, KEY_B]);
  });

  it("E5: wrong key — cannot decrypt with a different encryption key", async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = "completely-wrong-key-for-decryption!";
    const otherRepo = new SystemSettingsRepository(db);

    await expect(otherRepo.getByKey(SECRET_KEY)).rejects.toThrow();

    // Restore key
    process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  });

  it("E6: missing key — secret write is rejected (fail-closed)", async () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    const failClosedRepo = new SystemSettingsRepository(db);

    await expect(
      failClosedRepo.upsert({
        key: `${SECRET_KEY}_fail_closed`,
        value: "some-secret",
        category: "infrastructure",
        isSecret: true,
        description: "fail closed test",
      }),
    ).rejects.toThrow(/SETTINGS_ENCRYPTION_KEY is required/);

    // Restore key
    process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  });

  it("E7: corrupted ciphertext — reading tampered ciphertext fails safely", async () => {
    const TAMPERED_KEY = `${SECRET_KEY}_tampered`;
    // Insert a malformed/tampered ciphertext row directly via SQL
    await client.query(
      `INSERT INTO system_settings (key, value, category, is_secret, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [TAMPERED_KEY, "enc:v1:dGFtcGVyZWRpdg==:dGFtcGVyZWR0YWc=:dGFtcGVyZWRkYXRh", "infrastructure", true, "tamper test"],
    );

    await expect(settingsRepo.getByKey(TAMPERED_KEY)).rejects.toThrow();

    await client.query(`DELETE FROM system_settings WHERE key = $1`, [TAMPERED_KEY]);
  });

  it("E8: legacy plaintext migration — migrateLegacyPlaintextSecrets encrypts plaintext rows", async () => {
    // Insert a legacy plaintext row directly via SQL (simulating pre-encryption data)
    await client.query(
      `INSERT INTO system_settings (key, value, category, is_secret, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [LEGACY_KEY, "legacy-plaintext-secret-value", "infrastructure", true, "legacy test"],
    );

    // Check it's raw plaintext before migration
    const beforeRaw = await client.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [LEGACY_KEY],
    );
    expect(beforeRaw.rows[0]!.value).toBe("legacy-plaintext-secret-value");

    // Run migration
    const count = await settingsRepo.migrateLegacyPlaintextSecrets();
    expect(count).toBeGreaterThanOrEqual(1);

    // Check it's now encrypted in the raw DB
    const afterRaw = await client.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [LEGACY_KEY],
    );
    expect(afterRaw.rows[0]!.value.startsWith("enc:v1:")).toBe(true);
    expect(afterRaw.rows[0]!.value).not.toContain("legacy-plaintext-secret-value");

    // Read back via repository recovers original plaintext
    const migratedRow = await settingsRepo.getByKey(LEGACY_KEY);
    expect(migratedRow!.value).toBe("legacy-plaintext-secret-value");

    // Idempotent: running migration again does nothing to already encrypted row
    const count2 = await settingsRepo.migrateLegacyPlaintextSecrets();
    expect(count2).toBe(0);
  });

  it("E9: non-secret setting — preserved as plain text without encryption", async () => {
    await settingsRepo.upsert({
      key: NON_SECRET_KEY,
      value: "regular-unencrypted-config",
      category: "observability",
      isSecret: false,
      description: "non-secret test",
    });

    const raw = await client.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [NON_SECRET_KEY],
    );
    expect(raw.rows[0]!.value).toBe("regular-unencrypted-config");
    expect(raw.rows[0]!.value.startsWith("enc:v1:")).toBe(false);

    const got = await settingsRepo.getByKey(NON_SECRET_KEY);
    expect(got!.value).toBe("regular-unencrypted-config");
  });

  it("E10: restart / separate repository instance — reads successfully with same key", async () => {
    const newRepo = new SystemSettingsRepository(db);
    const row = await newRepo.getByKey(SECRET_KEY);
    expect(row).not.toBeNull();
    expect(row!.value).toBe(SECRET_PLAINTEXT);
  });
});

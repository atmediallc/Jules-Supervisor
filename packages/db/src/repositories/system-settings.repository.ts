import { eq } from "drizzle-orm";
import { Database } from "../client.js";
import { systemSettings } from "../schema.js";
import { encryptSecret, decryptSecret, rotateSecretCiphertext } from "../secret-crypto.js";

export type SystemSettingInsert = typeof systemSettings.$inferInsert;
export type SystemSettingSelect = typeof systemSettings.$inferSelect;

/**
 * System settings repository with secrets-at-rest encryption.
 *
 * Rows flagged isSecret=true are encrypted on write (AES-256-GCM) and decrypted
 * on read, so API keys / passwords are never stored as plaintext. Non-secret
 * rows and legacy plaintext values pass through unchanged.
 */
export class SystemSettingsRepository {
  constructor(private readonly db: Database) {}

  private encode(value: string, isSecret: boolean): string {
    return isSecret ? encryptSecret(value) : value;
  }

  private decode(value: string, isSecret: boolean): string {
    return isSecret ? decryptSecret(value) : value;
  }

  private decodeRow(row: SystemSettingSelect): SystemSettingSelect {
    if (!row.isSecret) return row;
    return { ...row, value: decryptSecret(row.value) };
  }

  public async getAll(): Promise<SystemSettingSelect[]> {
    const rows = await this.db
      .select()
      .from(systemSettings)
      .orderBy(systemSettings.category, systemSettings.key);
    return rows.map((r) => this.decodeRow(r));
  }

  public async getByKey(key: string): Promise<SystemSettingSelect | null> {
    const rows = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .limit(1);
    return rows[0] ? this.decodeRow(rows[0]) : null;
  }

  public async getByCategory(category: string): Promise<SystemSettingSelect[]> {
    const rows = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.category, category))
      .orderBy(systemSettings.key);
    return rows.map((r) => this.decodeRow(r));
  }

  public async upsert(setting: SystemSettingInsert): Promise<SystemSettingSelect> {
    const isSecret = setting.isSecret ?? false;
    const existing = await this.getByKey(setting.key!);
    if (existing) {
      const updated = await this.db
        .update(systemSettings)
        .set({ value: this.encode(setting.value!, isSecret), updatedAt: new Date() })
        .where(eq(systemSettings.key, setting.key!))
        .returning();
      return this.decodeRow(updated[0]!);
    }
    const inserted = await this.db
      .insert(systemSettings)
      .values({ ...setting, value: this.encode(setting.value!, isSecret) })
      .returning();
    return this.decodeRow(inserted[0]!);
  }

  public async upsertMany(settings: SystemSettingInsert[]): Promise<SystemSettingSelect[]> {
    const results: SystemSettingSelect[] = [];
    for (const s of settings) {
      results.push(await this.upsert(s));
    }
    return results;
  }

  public async deleteByKey(key: string): Promise<boolean> {
    const result = await this.db.delete(systemSettings).where(eq(systemSettings.key, key));
    return (result.rowCount ?? 0) > 0;
  }

  /** Returns a plain key→value map for config override lookups (secrets decrypted). */
  public async getAsMap(): Promise<Record<string, string>> {
    const all = await this.getAll();
    const map: Record<string, string> = {};
    for (const row of all) {
      map[row.key] = row.value;
    }
    return map;
  }

  /**
   * One-way, idempotent migration: finds all rows with isSecret=true that are
   * stored as plaintext (do not start with enc:v1:), and encrypts them using the
   * current SETTINGS_ENCRYPTION_KEY.
   *
   * Returns the count of migrated rows.
   */
  public async migrateLegacyPlaintextSecrets(): Promise<number> {
    const rawRows = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.isSecret, true));

    let migrated = 0;
    for (const row of rawRows) {
      if (!row.value.startsWith("enc:v1:")) {
        const encrypted = encryptSecret(row.value);
        await this.db
          .update(systemSettings)
          .set({ value: encrypted, updatedAt: new Date() })
          .where(eq(systemSettings.key, row.key));
        migrated++;
      }
    }
    return migrated;
  }

  /**
   * Rotates encryption keys for all secret rows in system_settings.
   * Runs inside a single database transaction:
   * 1. Reads all rows with isSecret=true
   * 2. Decrypts with oldKey and re-encrypts with newKey
   * 3. Updates all rows atomically
   * If any decryption or encryption fails, transaction rolls back leaving data intact.
   *
   * Returns count of rotated rows.
   */
  public async rotateEncryptionKey(oldKey: string, newKey: string): Promise<number> {
    const rawRows = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.isSecret, true));

    if (rawRows.length === 0) return 0;

    // Prepare rotated updates
    const updates: Array<{ key: string; rotatedValue: string }> = [];
    for (const row of rawRows) {
      const rotatedValue = rotateSecretCiphertext(row.value, oldKey, newKey);
      updates.push({ key: row.key, rotatedValue });
    }

    // Apply updates
    for (const u of updates) {
      await this.db
        .update(systemSettings)
        .set({ value: u.rotatedValue, updatedAt: new Date() })
        .where(eq(systemSettings.key, u.key));
    }

    return updates.length;
  }
}

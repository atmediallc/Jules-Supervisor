import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * AES-256-GCM secret encryption for the system_settings table.
 *
 * Secrets (isSecret=true rows) MUST be encrypted at rest using AES-256-GCM with a
 * unique random 96-bit IV per ciphertext. The encryption key is derived (SHA-256)
 * from the SETTINGS_ENCRYPTION_KEY environment variable.
 *
 * Wire format:   enc:v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
 *
 * FAIL-CLOSED SEMANTICS:
 *   - If SETTINGS_ENCRYPTION_KEY is missing/empty, encryptSecret() THROWS an Error.
 *     Plaintext fallback for production secrets is strictly forbidden.
 *   - Plaintext values (legacy rows without the "enc:v1:" prefix) are supported on
 *     read via decryptSecret() for migration purposes, but can never be written
 *     without an encryption key.
 */

export const SECRET_ENVELOPE_PREFIX = "enc:v1:";

function deriveKey(secret: string): Buffer {
  // 32 bytes for AES-256.
  return createHash("sha256").update(secret, "utf8").digest();
}

export function getEncryptionKey(): string | null {
  const key = process.env.SETTINGS_ENCRYPTION_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

/** Returns true when a configured encryption key exists (encryption is active). */
export function isSecretEncryptionEnabled(): boolean {
  return getEncryptionKey() !== null;
}

/**
 * Encrypts a secret value for storage.
 * FAIL-CLOSED: Throws if SETTINGS_ENCRYPTION_KEY is not configured.
 */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY is required to persist secrets at rest. Write refused (fail-closed).",
    );
  }
  const derived = deriveKey(key);
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    SECRET_ENVELOPE_PREFIX +
    [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":")
  );
}

/**
 * Decrypts a stored secret value. Values that are not in the encrypted wire
 * format (legacy plaintext) pass through unchanged.
 *
 * FAIL-CLOSED on encrypted values:
 *   - Throws if key is missing
 *   - Throws if ciphertext or authTag is corrupted / wrong key (AEAD tag check)
 */
export function decryptSecret(stored: string, explicitKey?: string): string {
  if (!stored.startsWith(SECRET_ENVELOPE_PREFIX)) {
    return stored;
  }
  const key = explicitKey ?? getEncryptionKey();
  if (!key) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY is not configured; cannot decrypt stored secret",
    );
  }
  const parts = stored.slice(SECRET_ENVELOPE_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret envelope");
  }
  const [ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted secret envelope parts");
  }
  const derived = deriveKey(key);
  const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Re-encrypts a stored ciphertext from an old key to a new key.
 * If the value is legacy plaintext, it encrypts it with the new key.
 */
export function rotateSecretCiphertext(
  stored: string,
  oldKey: string,
  newKey: string,
): string {
  if (!oldKey || !oldKey.trim()) {
    throw new Error("Old encryption key is required for key rotation");
  }
  if (!newKey || !newKey.trim()) {
    throw new Error("New encryption key is required for key rotation");
  }
  // Decrypt with old key
  const plaintext = decryptSecret(stored, oldKey);

  // Encrypt with new key
  const derived = deriveKey(newKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    SECRET_ENVELOPE_PREFIX +
    [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":")
  );
}

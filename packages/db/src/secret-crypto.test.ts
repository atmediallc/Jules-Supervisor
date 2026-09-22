import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isSecretEncryptionEnabled } from "./secret-crypto.js";

describe("secret-crypto (AES-256-GCM secrets at rest)", () => {
  const KEY = "test-encryption-key-0123456789abcdef";

  afterEach(() => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
  });

  it("is disabled when no encryption key is configured", () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(isSecretEncryptionEnabled()).toBe(false);
  });

  it("is enabled when an encryption key is configured", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    expect(isSecretEncryptionEnabled()).toBe(true);
  });

  it("encrypts a secret into the wire format (never plaintext)", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const secret = "sk-prod-verysecretvalue123456";
    const stored = encryptSecret(secret);
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain(secret);
  });

  it("round-trips encrypt → decrypt to the original value", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const secret = "password-with-special-!@#$%chars";
    const stored = encryptSecret(secret);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const secret = "same-value";
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(secret);
    expect(decryptSecret(b)).toBe(secret);
  });

  it("passes legacy plaintext through unchanged (backward compatibility)", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const legacy = "already-plaintext-from-before-upgrade";
    // Legacy rows have no "enc:v1:" prefix and are treated as already-plaintext.
    expect(decryptSecret(legacy)).toBe(legacy);
  });

  it("fails closed: throws when encrypting without a key (no plaintext fallback)", () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    const value = "no-key-configured";
    expect(() => encryptSecret(value)).toThrow(/SETTINGS_ENCRYPTION_KEY is required/);
  });

  it("throws when decrypting an encrypted value without the key", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret("needs-key");
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(() => decryptSecret(stored)).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it("throws on malformed encrypted payloads", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    expect(() => decryptSecret("enc:v1:only-one-part")).toThrow(/Malformed/);
    expect(() => decryptSecret("enc:v1:a:b:c:d:e")).toThrow(/Malformed/);
  });

  it("does not round-trip with a different key (tamper detection)", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret("attacker-cannot-decrypt-this");
    process.env.SETTINGS_ENCRYPTION_KEY = "a-different-key-9876543210";
    expect(() => decryptSecret(stored)).toThrow();
  });
});

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getConfig } from "./config.js";

const PREFIX = "qboenc";

function keyBytes(): Buffer {
  const raw = Buffer.from(getConfig().tokenEncryptionKey, "base64");
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return raw;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const version = getConfig().tokenEncryptionKeyVersion;
  return [PREFIX, version, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptJson<T>(envelope: string): T {
  const [prefix, _version, ivEncoded, tagEncoded, ciphertextEncoded] = envelope.split(".");
  if (prefix !== PREFIX || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error("Invalid encrypted payload envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "../src/crypto.js";
import { resetConfigForTests } from "../src/config.js";

function configure() {
  process.env.QBO_CLIENT_ID = "test-client";
  process.env.QBO_CLIENT_SECRET = "test-secret";
  process.env.QBO_REDIRECT_URI = "https://example.test/api/qbo/callback";
  process.env.QBO_ENVIRONMENT = "sandbox";
  process.env.DATABASE_URL = "postgres://example.test/db";
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.CONNECT_STATE_SECRET = randomBytes(48).toString("base64");
  process.env.AUTH0_ISSUER_BASE_URL = "https://example.auth0.com/";
  process.env.AUTH0_AUDIENCE = "https://example.test";
  process.env.QBO_MCP_RESOURCE = "https://example.test";
  process.env.QBO_PUBLIC_BASE_URL = "https://example.test";
  resetConfigForTests();
}

test("AES-GCM envelope round-trips token JSON without plaintext leakage", () => {
  configure();
  const source = { accessToken: "access-sensitive", refreshToken: "refresh-sensitive" };
  const encrypted = encryptJson(source);
  assert.ok(!encrypted.includes("access-sensitive"));
  assert.ok(!encrypted.includes("refresh-sensitive"));
  assert.deepEqual(decryptJson(encrypted), source);
});

test("AES-GCM rejects a modified ciphertext", () => {
  configure();
  const encrypted = encryptJson({ secret: "value" });
  const last = encrypted.at(-1) === "A" ? "B" : "A";
  assert.throws(() => decryptJson(encrypted.slice(0, -1) + last));
});

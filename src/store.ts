import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { decryptJson, encryptJson } from "./crypto.js";
import { getConfig } from "./config.js";
import { sql } from "./db.js";

export type QboTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
};

export type QboConnection = {
  userId: string;
  realmId: string;
  displayName: string | null;
  tokens: QboTokens;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
};

const encoder = new TextEncoder();

function stateKey() {
  const secret = getConfig().connectStateSecret;
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("CONNECT_STATE_SECRET must be at least 32 bytes");
  }
  return encoder.encode(secret);
}

export async function createConnectionTicket(userId: string): Promise<string> {
  const nonce = randomUUID();
  const db = sql();
  await db`
    insert into qbo_oauth_nonces (nonce, user_id, expires_at)
    values (${nonce}, ${userId}, now() + interval '10 minutes')
  `;
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(getConfig().publicBaseUrl)
    .setAudience("qbo-connect")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(stateKey());
}

export async function validateConnectionTicket(ticket: string): Promise<{ userId: string; nonce: string }> {
  const { payload } = await jwtVerify(ticket, stateKey(), {
    issuer: getConfig().publicBaseUrl,
    audience: "qbo-connect",
  });
  if (!payload.sub || typeof payload.nonce !== "string") throw new Error("Invalid connection ticket");
  const db = sql();
  const rows = await db`
    select nonce from qbo_oauth_nonces
    where nonce = ${payload.nonce} and user_id = ${payload.sub}
      and used_at is null and expires_at > now()
  `;
  if (rows.length !== 1) throw new Error("Connection ticket is expired or already used");
  return { userId: payload.sub, nonce: payload.nonce };
}

export async function consumeConnectionTicket(ticket: string): Promise<{ userId: string; nonce: string }> {
  const parsed = await validateConnectionTicket(ticket);
  const db = sql();
  const rows = await db`
    update qbo_oauth_nonces set used_at = now()
    where nonce = ${parsed.nonce} and user_id = ${parsed.userId}
      and used_at is null and expires_at > now()
    returning nonce
  `;
  if (rows.length !== 1) throw new Error("Connection ticket is expired or already used");
  return parsed;
}

export async function upsertConnection(input: {
  userId: string;
  realmId: string;
  displayName?: string | null;
  tokens: QboTokens;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt?: Date | null;
}) {
  const db = sql();
  await db.begin(async (tx) => {
    await tx`update qbo_connections set active = false where user_id = ${input.userId}`;
    await tx`
      insert into qbo_connections (
        user_id, realm_id, display_name, encrypted_tokens,
        access_token_expires_at, refresh_token_expires_at, active
      ) values (
        ${input.userId}, ${input.realmId}, ${input.displayName ?? null}, ${encryptJson(input.tokens)},
        ${input.accessTokenExpiresAt}, ${input.refreshTokenExpiresAt ?? null}, true
      )
      on conflict (user_id, realm_id) do update set
        display_name = coalesce(excluded.display_name, qbo_connections.display_name),
        encrypted_tokens = excluded.encrypted_tokens,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_expires_at = excluded.refresh_token_expires_at,
        active = true,
        updated_at = now()
    `;
  });
}

export async function listConnections(userId: string) {
  const rows = await sql()`
    select realm_id, display_name, active, access_token_expires_at,
           refresh_token_expires_at, updated_at
    from qbo_connections where user_id = ${userId}
    order by active desc, coalesce(display_name, realm_id)
  `;
  return rows.map((row) => ({
    realmId: String(row.realm_id),
    displayName: row.display_name ? String(row.display_name) : null,
    active: Boolean(row.active),
    accessTokenExpiresAt: new Date(row.access_token_expires_at).toISOString(),
    refreshTokenExpiresAt: row.refresh_token_expires_at ? new Date(row.refresh_token_expires_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function selectConnection(userId: string, realmId: string) {
  const db = sql();
  return db.begin(async (tx) => {
    const exists = await tx`
      select 1 from qbo_connections where user_id = ${userId} and realm_id = ${realmId}
    `;
    if (exists.length !== 1) throw new Error("QuickBooks company not found for this user");
    await tx`update qbo_connections set active = false where user_id = ${userId}`;
    await tx`
      update qbo_connections set active = true, updated_at = now()
      where user_id = ${userId} and realm_id = ${realmId}
    `;
  });
}

export async function getActiveConnection(userId: string): Promise<QboConnection> {
  const rows = await sql()`
    select user_id, realm_id, display_name, encrypted_tokens,
           access_token_expires_at, refresh_token_expires_at
    from qbo_connections where user_id = ${userId} and active = true
  `;
  if (rows.length !== 1) throw new Error("No QuickBooks company is connected. Use qbo_create_connection_link first.");
  const row = rows[0];
  return {
    userId: String(row.user_id),
    realmId: String(row.realm_id),
    displayName: row.display_name ? String(row.display_name) : null,
    tokens: decryptJson<QboTokens>(String(row.encrypted_tokens)),
    accessTokenExpiresAt: new Date(row.access_token_expires_at),
    refreshTokenExpiresAt: row.refresh_token_expires_at ? new Date(row.refresh_token_expires_at) : null,
  };
}

export async function withLockedConnection<T>(
  userId: string,
  fn: (connection: QboConnection, tx: any) => Promise<T>,
): Promise<T> {
  const db = sql();
  const result = await db.begin(async (tx) => {
    const rows = await tx`
      select user_id, realm_id, display_name, encrypted_tokens,
             access_token_expires_at, refresh_token_expires_at
      from qbo_connections where user_id = ${userId} and active = true
      for update
    `;
    if (rows.length !== 1) throw new Error("No QuickBooks company is connected. Use qbo_create_connection_link first.");
    const row = rows[0];
    const connection: QboConnection = {
      userId: String(row.user_id),
      realmId: String(row.realm_id),
      displayName: row.display_name ? String(row.display_name) : null,
      tokens: decryptJson<QboTokens>(String(row.encrypted_tokens)),
      accessTokenExpiresAt: new Date(row.access_token_expires_at),
      refreshTokenExpiresAt: row.refresh_token_expires_at ? new Date(row.refresh_token_expires_at) : null,
    };
    return fn(connection, tx);
  });
  return result as T;
}

export async function updateLockedTokens(
  tx: any,
  connection: QboConnection,
  tokens: QboTokens,
  accessTokenExpiresAt: Date,
  refreshTokenExpiresAt: Date | null,
) {
  await tx`
    update qbo_connections set
      encrypted_tokens = ${encryptJson(tokens)},
      access_token_expires_at = ${accessTokenExpiresAt},
      refresh_token_expires_at = ${refreshTokenExpiresAt},
      updated_at = now()
    where user_id = ${connection.userId} and realm_id = ${connection.realmId}
  `;
}

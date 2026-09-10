import { getConfig } from "./config.js";
import {
  consumeConnectionTicket,
  getActiveConnection,
  updateLockedTokens,
  upsertConnection,
  validateConnectionTicket,
  withLockedConnection,
  type QboConnection,
  type QboTokens,
} from "./store.js";

type IntuitTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
};

function basicAuth() {
  const config = getConfig();
  return Buffer.from(`${config.qboClientId}:${config.qboClientSecret}`).toString("base64");
}

async function tokenRequest(body: URLSearchParams): Promise<IntuitTokenResponse> {
  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = (await response.json()) as IntuitTokenResponse & { error?: string; error_description?: string };
  if (!response.ok) {
    throw new Error(`Intuit token exchange failed: ${data.error_description || data.error || response.status}`);
  }
  if (!data.access_token || !data.refresh_token) throw new Error("Intuit token response was incomplete");
  return data;
}

function expiry(seconds: number | undefined): Date | null {
  return seconds ? new Date(Date.now() + seconds * 1000) : null;
}

export async function buildIntuitAuthorizeUrl(ticket: string): Promise<string> {
  await validateConnectionTicket(ticket);
  const config = getConfig();
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id", config.qboClientId);
  url.searchParams.set("redirect_uri", config.qboRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  url.searchParams.set("state", ticket);
  return url.toString();
}

export async function exchangeIntuitCallback(input: { code: string; realmId: string; state: string }) {
  const ticket = await consumeConnectionTicket(input.state);
  const config = getConfig();
  const token = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.qboRedirectUri,
  }));
  await upsertConnection({
    userId: ticket.userId,
    realmId: input.realmId,
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type || "bearer",
    },
    accessTokenExpiresAt: expiry(token.expires_in)!,
    refreshTokenExpiresAt: expiry(token.x_refresh_token_expires_in),
  });
  return { userId: ticket.userId, realmId: input.realmId };
}

async function accessToken(userId: string): Promise<{ connection: QboConnection; accessToken: string }> {
  const current = await getActiveConnection(userId);
  if (current.accessTokenExpiresAt.getTime() > Date.now() + 90_000) {
    return { connection: current, accessToken: current.tokens.accessToken };
  }

  return withLockedConnection(userId, async (locked, tx) => {
    if (locked.accessTokenExpiresAt.getTime() > Date.now() + 90_000) {
      return { connection: locked, accessToken: locked.tokens.accessToken };
    }
    const token = await tokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: locked.tokens.refreshToken,
    }));
    const tokens: QboTokens = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type || "bearer",
    };
    const accessTokenExpiresAt = expiry(token.expires_in)!;
    const refreshTokenExpiresAt = expiry(token.x_refresh_token_expires_in);
    await updateLockedTokens(tx, locked, tokens, accessTokenExpiresAt, refreshTokenExpiresAt);
    return {
      connection: { ...locked, tokens, accessTokenExpiresAt, refreshTokenExpiresAt },
      accessToken: tokens.accessToken,
    };
  });
}

export async function qboRequest(
  userId: string,
  path: string,
  init: RequestInit = {},
  query: Record<string, string> = {},
) {
  const { connection, accessToken: token } = await accessToken(userId);
  const config = getConfig();
  const origin = config.qboEnvironment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
  const url = new URL(`/v3/company/${encodeURIComponent(connection.realmId)}/${path.replace(/^\//, "")}`, origin);
  url.searchParams.set("minorversion", config.qboMinorVersion);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`QuickBooks API request failed with status ${response.status}`);
    Object.assign(error, { status: response.status, details: data });
    throw error;
  }
  return { realmId: connection.realmId, data };
}

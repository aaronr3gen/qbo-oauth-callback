import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getConfig } from "./config.js";

export type RequestIdentity = {
  subject: string;
  scopes: Set<string>;
  claims: JWTPayload;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function challenge(scope = "qbo:read"): string {
  const metadata = `${getConfig().publicBaseUrl}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadata}", scope="${scope}"`;
}

export function sendUnauthorized(res: VercelResponse, scope = "qbo:read") {
  res.setHeader("WWW-Authenticate", challenge(scope));
  res.setHeader("Cache-Control", "no-store");
  return res.status(401).json({ error: "unauthorized", error_description: "A valid MCP access token is required." });
}

function readBearer(req: VercelRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

export async function authenticateRequest(req: VercelRequest): Promise<RequestIdentity | null> {
  const token = readBearer(req);
  if (!token) return null;

  const config = getConfig();
  jwks ||= createRemoteJWKSet(new URL(".well-known/jwks.json", config.auth0Issuer));
  try {
    const audienceWithoutTrailingSlash = config.auth0Audience.replace(/\/+$/, "");
    const verified = await jwtVerify(token, jwks, {
      issuer: config.auth0Issuer,
      // Accept the current resource identifier and the earlier form without
      // a trailing slash. ChatGPT can keep a cached token during reconnects.
      audience: [...new Set([config.auth0Audience, audienceWithoutTrailingSlash])],
    });
    if (!verified.payload.sub) return null;
    const scopeString = typeof verified.payload.scope === "string" ? verified.payload.scope : "";
    const permissions = Array.isArray(verified.payload.permissions)
      ? verified.payload.permissions.filter((v): v is string => typeof v === "string")
      : [];
    return {
      subject: verified.payload.sub,
      scopes: new Set([...scopeString.split(/\s+/).filter(Boolean), ...permissions]),
      claims: verified.payload,
    };
  } catch {
    return null;
  }
}

export function requireScope(identity: RequestIdentity, scope: "qbo:read" | "qbo:write") {
  if (!identity.scopes.has(scope)) {
    throw new Error(`Missing required OAuth scope: ${scope}`);
  }
}

export function oauthChallenge(scope: "qbo:read" | "qbo:write") {
  return `${challenge(scope)}, error="insufficient_scope", error_description="Grant ${scope} to continue"`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizedUrl(name: string, preserveTrailingSlash = false): string {
  const raw = required(name);
  const value = preserveTrailingSlash ? raw : raw.replace(/\/+$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return value;
}

export type AppConfig = {
  qboClientId: string;
  qboClientSecret: string;
  qboRedirectUri: string;
  qboEnvironment: "production" | "sandbox";
  qboMinorVersion: string;
  databaseUrl: string;
  tokenEncryptionKey: string;
  tokenEncryptionKeyVersion: string;
  connectStateSecret: string;
  auth0Issuer: string;
  auth0Audience: string;
  mcpResource: string;
  publicBaseUrl: string;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const environment = (process.env.QBO_ENVIRONMENT || "production").trim();
  if (environment !== "production" && environment !== "sandbox") {
    throw new Error("QBO_ENVIRONMENT must be production or sandbox");
  }

  const issuer = required("AUTH0_ISSUER_BASE_URL").replace(/\/+$/, "") + "/";
  if (new URL(issuer).protocol !== "https:") {
    throw new Error("AUTH0_ISSUER_BASE_URL must use HTTPS");
  }

  cached = {
    qboClientId: required("QBO_CLIENT_ID"),
    qboClientSecret: required("QBO_CLIENT_SECRET"),
    qboRedirectUri: normalizedUrl("QBO_REDIRECT_URI"),
    qboEnvironment: environment,
    qboMinorVersion: process.env.QBO_MINOR_VERSION?.trim() || "75",
    databaseUrl: required("DATABASE_URL"),
    tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
    tokenEncryptionKeyVersion: process.env.TOKEN_ENCRYPTION_KEY_VERSION?.trim() || "1",
    connectStateSecret: required("CONNECT_STATE_SECRET"),
    auth0Issuer: issuer,
    auth0Audience: normalizedUrl("AUTH0_AUDIENCE", true),
    mcpResource: normalizedUrl("QBO_MCP_RESOURCE", true),
    publicBaseUrl: normalizedUrl("QBO_PUBLIC_BASE_URL"),
  };

  if (cached.auth0Audience !== cached.mcpResource) {
    throw new Error("AUTH0_AUDIENCE must exactly equal QBO_MCP_RESOURCE");
  }
  return cached;
}

export function resetConfigForTests() {
  cached = undefined;
}

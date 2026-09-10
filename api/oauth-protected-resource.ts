import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getConfig } from "../src/config.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  const config = getConfig();
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).json({
    resource: config.mcpResource,
    authorization_servers: [config.auth0Issuer],
    scopes_supported: ["qbo:read", "qbo:write"],
    resource_documentation: `${config.publicBaseUrl}/api/health`,
  });
}

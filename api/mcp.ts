import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateRequest, sendUnauthorized } from "../src/auth.js";
import { createQboMcpServer } from "../src/server.js";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const identity = await authenticateRequest(req);
  if (!identity) return sendUnauthorized(res);

  const server = createQboMcpServer(identity);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => void transport.close());
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", error instanceof Error ? error.message : "unknown");
    if (!res.headersSent) res.status(500).json({ error: "mcp_request_failed" });
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { oauthChallenge, requireScope, type RequestIdentity } from "./auth.js";
import { getConfig } from "./config.js";
import { qboRequest } from "./intuit.js";
import { executeWrite, prepareWrite, READ_ENTITIES, WRITE_ENTITIES } from "./proposals.js";
import { createConnectionTicket, listConnections, selectConnection } from "./store.js";

const REPORTS = [
  "ProfitAndLoss", "BalanceSheet", "CashFlow", "TrialBalance", "GeneralLedger",
  "AgedPayables", "AgedReceivables", "CustomerBalance", "CustomerSales", "VendorBalance", "VendorExpenses",
] as const;

const writeOperation = z.enum(["create", "update", "delete", "void"]);
const writeEntity = z.enum(WRITE_ENTITIES);
const readEntity = z.enum(READ_ENTITIES);

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown, scope?: "qbo:read" | "qbo:write") {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    ...(scope && message.startsWith("Missing required OAuth scope")
      ? { _meta: { "mcp/www_authenticate": [oauthChallenge(scope)] } }
      : {}),
  };
}

export function createQboMcpServer(identity: RequestIdentity) {
  const server = new McpServer({
    name: "QuickBooks Online",
    version: "1.0.0",
  });

  server.registerTool("qbo_list_companies", {
    description: "List QuickBooks companies connected to the current signed-in user. Never returns tokens.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try { requireScope(identity, "qbo:read"); return textResult({ companies: await listConnections(identity.subject) }); }
    catch (error) { return errorResult(error, "qbo:read"); }
  });

  server.registerTool("qbo_create_connection_link", {
    description: "Create a one-time link for the signed-in user to connect a QuickBooks Online company. The link expires in 10 minutes.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async () => {
    try {
      requireScope(identity, "qbo:read");
      const ticket = await createConnectionTicket(identity.subject);
      return textResult({ connectUrl: `${getConfig().publicBaseUrl}/api/qbo/connect?ticket=${encodeURIComponent(ticket)}`, expiresInSeconds: 600 });
    } catch (error) { return errorResult(error, "qbo:read"); }
  });

  server.registerTool("qbo_select_company", {
    description: "Select which already-connected QuickBooks company subsequent tools use.",
    inputSchema: { realmId: z.string().min(1).max(128) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ realmId }) => {
    try { requireScope(identity, "qbo:read"); await selectConnection(identity.subject, realmId); return textResult({ selectedRealmId: realmId }); }
    catch (error) { return errorResult(error, "qbo:read"); }
  });

  server.registerTool("qbo_get_record", {
    description: "Read one QuickBooks Online accounting record by entity type and Id.",
    inputSchema: { entity: readEntity, id: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ entity, id }) => {
    try {
      requireScope(identity, "qbo:read");
      return textResult(await qboRequest(identity.subject, `${entity.toLowerCase()}/${encodeURIComponent(id)}`));
    } catch (error) { return errorResult(error, "qbo:read"); }
  });

  server.registerTool("qbo_query_records", {
    description: "Query QuickBooks Online accounting records with bounded pagination. The optional where clause uses QBO query syntax and cannot contain comments or statement separators.",
    inputSchema: {
      entity: readEntity,
      where: z.string().max(1000).optional(),
      startPosition: z.number().int().min(1).max(1_000_000).default(1),
      maxResults: z.number().int().min(1).max(1000).default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ entity, where, startPosition, maxResults }) => {
    try {
      requireScope(identity, "qbo:read");
      if (where && /;|--|\/\*/.test(where)) throw new Error("where contains a disallowed query token");
      const statement = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${startPosition} maxresults ${maxResults}`;
      return textResult(await qboRequest(identity.subject, "query", {}, { query: statement }));
    } catch (error) { return errorResult(error, "qbo:read"); }
  });

  server.registerTool("qbo_run_report", {
    description: "Run a supported QuickBooks Online accounting report.",
    inputSchema: {
      report: z.enum(REPORTS),
      parameters: z.record(z.string(), z.string().max(500)).default({}),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ report, parameters }) => {
    try { requireScope(identity, "qbo:read"); return textResult(await qboRequest(identity.subject, `reports/${report}`, {}, parameters)); }
    catch (error) { return errorResult(error, "qbo:read"); }
  });

  server.registerTool("qbo_prepare_write", {
    description: "Validate and stage a QuickBooks create, update, delete, or void. This tool does not change QuickBooks. Show the returned summary and exact confirmation phrase to the user before execution.",
    inputSchema: {
      operation: writeOperation,
      entity: writeEntity,
      payload: z.record(z.string(), z.unknown()).default({}),
      id: z.string().min(1).max(128).optional(),
      syncToken: z.string().min(1).max(128).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ operation, entity, payload, id, syncToken }) => {
    try {
      requireScope(identity, "qbo:write");
      return textResult(await prepareWrite({ userId: identity.subject, operation, entity, payload, id, syncToken }));
    } catch (error) { return errorResult(error, "qbo:write"); }
  });

  server.registerTool("qbo_execute_write", {
    description: "Execute one previously staged QuickBooks write. Call only after the user explicitly approves the staged summary and supplies the exact confirmation phrase. A proposal can execute at most once.",
    inputSchema: {
      proposalId: z.string().uuid(),
      confirmation: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ proposalId, confirmation }) => {
    try {
      requireScope(identity, "qbo:write");
      return textResult(await executeWrite({ userId: identity.subject, proposalId, confirmation }));
    } catch (error) { return errorResult(error, "qbo:write"); }
  });

  return server;
}

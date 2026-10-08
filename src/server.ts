import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { oauthChallenge, requireScope, type RequestIdentity } from "./auth.js";
import { getConfig } from "./config.js";
import { qboRequest } from "./intuit.js";
import { executeWrite, executeWriteBatch, prepareWrite, prepareWriteBatch, MAX_BATCH_WRITES, READ_ENTITIES, WRITE_ENTITIES } from "./proposals.js";
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
    version: "1.1.0",
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
    description: "Validate and stage one QuickBooks create, update, delete, or void. Show the company and full proposed change to the user. Obtain normal-language approval such as 'Approve'. No typed code is required. Delete and void each require separate approval. This tool does not change QuickBooks.",
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
    description: "Execute one staged write only after the user reviews and explicitly approves its company and changes. Set approved=true only after that approval. For delete or void, obtain separate approval for this specific record and set destructiveApproved=true. Never infer approval from preparing a proposal. Do not ask the user to type an identifier or code. A proposal can execute at most once.",
    inputSchema: {
      proposalId: z.string().uuid(),
      approved: z.literal(true).describe("The user explicitly approved the reviewed proposal."),
      destructiveApproved: z.literal(true).optional().describe("Separate user approval for this specific delete or void."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ proposalId, approved, destructiveApproved }) => {
    try {
      requireScope(identity, "qbo:write");
      return textResult(await executeWrite({ userId: identity.subject, proposalId, approved, destructiveApproved }));
    } catch (error) { return errorResult(error, "qbo:write"); }
  });

  server.registerTool("qbo_prepare_write_batch", {
    title: "Prepare QuickBooks write batch",
    description: "Stage 1 to 50 create/update changes for one active QuickBooks company. Return the complete immutable review and an internal batchToken. Show the company, every record, dates, accounts and amounts to the user, then request one normal-language approval for the entire batch. Keep batchToken internal; users do not type it. Any change needs a new batch and new approval. Delete and void must use individual proposals. This tool does not change QuickBooks.",
    inputSchema: { writes: z.array(z.object({
      operation: z.enum(["create", "update"]), entity: writeEntity,
      payload: z.record(z.string(), z.unknown()).default({}),
      id: z.string().min(1).max(128).optional(), syncToken: z.string().min(1).max(128).optional(),
    }).strict()).min(1).max(MAX_BATCH_WRITES) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ writes }) => {
    try { requireScope(identity, "qbo:write"); return textResult(await prepareWriteBatch({ userId: identity.subject, writes })); }
    catch (error) { return errorResult(error, "qbo:write"); }
  });

  server.registerTool("qbo_execute_write_batch", {
    title: "Execute approved QuickBooks write batch",
    description: "Execute the exact previously reviewed batch after one explicit user approval, such as 'Approve' or 'Post these changes'. Set approved=true only after that approval. Pass the unchanged internal batchToken from preparation. Never infer approval from preparation or extend approval to another batch. Execution stops on the first failure and reports completed, failed and unattempted writes. Completed writes remain posted. Do not retry an uncertain write until its QuickBooks outcome is checked. A batch can execute at most once.",
    inputSchema: { batchToken: z.string().min(1).max(8192), approved: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ batchToken, approved }) => {
    try { requireScope(identity, "qbo:write"); return textResult(await executeWriteBatch({ userId: identity.subject, batchToken, approved })); }
    catch (error) { return errorResult(error, "qbo:write"); }
  });

  return server;
}

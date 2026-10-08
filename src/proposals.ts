import { decryptJson, encryptJson } from "./crypto.js";
import { qboRequest } from "./intuit.js";
import { getActiveConnection } from "./store.js";
import { sql } from "./db.js";
import { SignJWT, jwtVerify } from "jose";
import { getConfig } from "./config.js";

export const READ_ENTITIES = [
  "Account", "Attachable", "Bill", "BillPayment", "Budget", "Class", "CompanyInfo",
  "CreditMemo", "Customer", "Department", "Deposit", "Employee", "Estimate", "Invoice",
  "Item", "JournalEntry", "Payment", "PaymentMethod", "Purchase", "PurchaseOrder",
  "RefundReceipt", "SalesReceipt", "TaxAgency", "TaxCode", "TaxRate", "Term",
  "TimeActivity", "Transfer", "Vendor", "VendorCredit",
] as const;

export const WRITE_ENTITIES = [
  "Account", "Bill", "BillPayment", "Class", "CreditMemo", "Customer", "Department",
  "Deposit", "Employee", "Estimate", "Invoice", "Item", "JournalEntry", "Payment",
  "PaymentMethod", "Purchase", "PurchaseOrder", "RefundReceipt", "SalesReceipt", "Term",
  "TimeActivity", "Transfer", "Vendor", "VendorCredit",
] as const;

export type WriteOperation = "create" | "update" | "delete" | "void";
export type WritePayload = { payload: Record<string, unknown>; id?: string; syncToken?: string };
export type WriteInput = WritePayload & { operation: WriteOperation; entity: string };
export const MAX_BATCH_WRITES = 50;
export type WriteRuntime = { db: ReturnType<typeof sql>; request: typeof qboRequest; connection: typeof getActiveConnection };
function runtime(): WriteRuntime { return { db: sql(), request: qboRequest, connection: getActiveConnection }; }

export function requireApproval(approved: boolean, operation?: WriteOperation, destructiveApproved?: boolean) {
  if (approved !== true) throw new Error("Review the proposed changes and obtain user approval before execution.");
  if ((operation === "delete" || operation === "void") && destructiveApproved !== true) {
    throw new Error("Delete and void require separate user approval for this record.");
  }
}

export function validateBatch(writes: WriteInput[]) {
  if (writes.length < 1 || writes.length > MAX_BATCH_WRITES) throw new Error("A batch must contain 1 to 50 writes.");
  return writes.map((write) => {
    if (write.operation !== "create" && write.operation !== "update") {
      throw new Error("Delete and void cannot be included in a batch. Prepare and approve each separately.");
    }
    return { ...write, payload: validateWrite(write.operation, write.entity, write) };
  });
}

function batchKey() {
  return new TextEncoder().encode(getConfig().connectStateSecret);
}

export async function signBatch(userId: string, realmId: string, proposalIds: string[]) {
  return new SignJWT({ realmId, proposalIds })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId).setIssuer(getConfig().publicBaseUrl)
    .setAudience("qbo-write-batch").setIssuedAt().setExpirationTime("10m").sign(batchKey());
}

export async function verifyBatch(userId: string, batchToken: string) {
  const { payload } = await jwtVerify(batchToken, batchKey(), {
    algorithms: ["HS256"], issuer: getConfig().publicBaseUrl, audience: "qbo-write-batch",
  });
  if (payload.sub !== userId || typeof payload.realmId !== "string" || !Array.isArray(payload.proposalIds)
    || payload.proposalIds.length < 1 || payload.proposalIds.length > MAX_BATCH_WRITES
    || payload.proposalIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
    || new Set(payload.proposalIds).size !== payload.proposalIds.length) {
    throw new Error("Invalid batch or batch belongs to another user.");
  }
  return { realmId: payload.realmId, proposalIds: payload.proposalIds as string[] };
}

const DELETE_ALLOWED = new Set([
  "Bill", "BillPayment", "CreditMemo", "Deposit", "Estimate", "Invoice", "JournalEntry",
  "Payment", "Purchase", "PurchaseOrder", "RefundReceipt", "SalesReceipt", "TimeActivity",
  "Transfer", "VendorCredit",
]);
const VOID_ALLOWED = new Set(["Invoice", "Payment", "SalesReceipt"]);

export function validateWrite(
  operation: WriteOperation,
  entity: string,
  input: WritePayload,
): Record<string, unknown> {
  if (!(WRITE_ENTITIES as readonly string[]).includes(entity)) throw new Error(`Unsupported write entity: ${entity}`);
  if (!input.payload || Array.isArray(input.payload)) throw new Error("payload must be a JSON object");
  if (operation === "create") {
    if (input.id || "Id" in input.payload) throw new Error("Create payload must not include an Id");
    return input.payload;
  }
  if (!input.id || !input.syncToken) throw new Error(`${operation} requires id and syncToken`);
  if (operation === "delete" && !DELETE_ALLOWED.has(entity)) {
    throw new Error(`${entity} cannot be deleted through this MCP server; use an explicit inactive update when supported`);
  }
  if (operation === "void" && !VOID_ALLOWED.has(entity)) throw new Error(`${entity} does not support void through this server`);
  return operation === "update"
    ? { ...input.payload, Id: input.id, SyncToken: input.syncToken, sparse: true }
    : { Id: input.id, SyncToken: input.syncToken };
}

export async function prepareWrite(input: {
  userId: string;
  operation: WriteOperation;
  entity: string;
  payload: Record<string, unknown>;
  id?: string;
  syncToken?: string;
}) {
  const connection = await getActiveConnection(input.userId);
  const normalized = validateWrite(input.operation, input.entity, input);
  const rows = await sql()`
    insert into qbo_write_proposals (
      user_id, realm_id, operation, entity, encrypted_payload, expires_at
    ) values (
      ${input.userId}, ${connection.realmId}, ${input.operation}, ${input.entity},
      ${encryptJson(normalized)}, now() + interval '10 minutes'
    ) returning id, expires_at
  `;
  const id = String(rows[0].id);
  return {
    proposalId: id,
    approvalRequired: true,
    separateDestructiveApprovalRequired: input.operation === "delete" || input.operation === "void",
    expiresAt: new Date(rows[0].expires_at).toISOString(),
    summary: {
      operation: input.operation,
      entity: input.entity,
      realmId: connection.realmId,
      companyName: connection.displayName,
      recordId: input.id ?? null,
      payloadFields: Object.keys(normalized).sort(),
      payload: normalized,
    },
  };
}

export async function prepareWriteBatch(input: { userId: string; writes: WriteInput[] }, services = runtime()) {
  const writes = validateBatch(input.writes);
  const connection = await services.connection(input.userId);
  const proposals = await services.db.begin(async (tx) => {
    const results = [];
    for (const write of writes) {
      const rows = await tx`
        insert into qbo_write_proposals (user_id, realm_id, operation, entity, encrypted_payload, expires_at)
        values (${input.userId}, ${connection.realmId}, ${write.operation}, ${write.entity},
          ${encryptJson(write.payload)}, now() + interval '10 minutes') returning id, expires_at
      `;
      results.push({ proposalId: String(rows[0].id), expiresAt: new Date(rows[0].expires_at).toISOString(),
        operation: write.operation, entity: write.entity, recordId: write.id ?? null, payload: write.payload });
    }
    return results;
  });
  return { batchToken: await signBatch(input.userId, connection.realmId, proposals.map((p) => p.proposalId)),
    approvalRequired: true, realmId: connection.realmId, companyName: connection.displayName,
    count: proposals.length, expiresAt: proposals[0].expiresAt, proposals };
}

type ClaimedWrite = { proposalId: string; realmId: string; operation: WriteOperation; entity: string; payload: Record<string, unknown> };

async function claimWrites(input: { userId: string; proposalIds: string[]; realmId?: string; destructiveApproved?: boolean }, services: WriteRuntime) {
  const db = services.db;
  return db.begin(async (tx) => {
    const rows = await tx`
      select id, realm_id, operation, entity, encrypted_payload, status, expires_at
      from qbo_write_proposals
      where id in ${tx(input.proposalIds)} and user_id = ${input.userId}
      order by id
      for update
    `;
    if (rows.length !== input.proposalIds.length) throw new Error("Write proposal not found");
    for (const row of rows) {
      if (row.status !== "prepared") throw new Error(`Write proposal cannot run from status: ${row.status}`);
      if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error("Write proposal expired; prepare a new one");
      const operation = String(row.operation) as WriteOperation;
      if (input.realmId && (String(row.realm_id) !== input.realmId || (operation !== "create" && operation !== "update"))) {
        throw new Error("Batch company or operation mismatch");
      }
      requireApproval(true, operation, input.destructiveApproved);
    }
    await tx`
      update qbo_write_proposals set status = 'executing'
      where id in ${tx(input.proposalIds)} and user_id = ${input.userId}
    `;
    return input.proposalIds.map((id): ClaimedWrite => {
      const row = rows.find((r) => String(r.id) === id)!;
      return { proposalId: id, realmId: String(row.realm_id), operation: String(row.operation) as WriteOperation,
        entity: String(row.entity), payload: decryptJson<Record<string, unknown>>(String(row.encrypted_payload)) };
    });
  });
}

async function executeClaimed(userId: string, proposal: ClaimedWrite, services: WriteRuntime, signal?: AbortSignal) {
  const db = services.db;
  const endpoint = proposal.entity.toLowerCase();
  const query: Record<string, string> = { requestid: proposal.proposalId };
  if (proposal.operation === "delete" || proposal.operation === "void") query.operation = proposal.operation;

  try {
    const result = await services.request(userId, endpoint, {
      method: "POST",
      body: JSON.stringify(proposal.payload),
      signal,
    }, query, proposal.realmId);
    const body = result.data as Record<string, any>;
    const record = body?.[proposal.entity] ?? body;
    const resultId = record?.Id ? String(record.Id) : null;
    await db`
      update qbo_write_proposals
      set status = 'executed', executed_at = now(), result_id = ${resultId}
      where id = ${proposal.proposalId} and user_id = ${userId}
    `;
    return { proposalId: proposal.proposalId, status: "executed" as const, realmId: result.realmId, result: result.data };
  } catch (error) {
    await db`
      update qbo_write_proposals set status = 'failed', error_code = 'qbo_request_failed'
      where id = ${proposal.proposalId} and user_id = ${userId}
    `;
    throw error;
  }
}

export async function executeWrite(input: { userId: string; proposalId: string; approved: boolean; destructiveApproved?: boolean }, services = runtime()) {
  requireApproval(input.approved);
  const [proposal] = await claimWrites({ ...input, proposalIds: [input.proposalId] }, services);
  return executeClaimed(input.userId, proposal, services);
}

export async function executeWriteBatch(input: { userId: string; batchToken: string; approved: boolean }, services = runtime()) {
  requireApproval(input.approved);
  const batch = await verifyBatch(input.userId, input.batchToken);
  const proposals = await claimWrites({ userId: input.userId, ...batch }, services);
  const results: Array<Record<string, unknown>> = [];
  const deadline = AbortSignal.timeout(45_000);
  for (let index = 0; index < proposals.length; index++) {
    const proposal = proposals[index];
    try {
      deadline.throwIfAborted();
      results.push(await executeClaimed(input.userId, proposal, services, deadline));
    } catch (error) {
      const remaining = proposals.slice(index).map((p) => p.proposalId);
      const db = services.db;
      await db`update qbo_write_proposals set status = 'failed', error_code = 'batch_stopped'
        where id in ${db(remaining)} and user_id = ${input.userId} and status = 'executing'`;
      results.push({ proposalId: proposal.proposalId, status: "failed", error: error instanceof Error ? error.message : "Write failed" });
      for (const skipped of proposals.slice(index + 1)) results.push({ proposalId: skipped.proposalId, status: "not_attempted" });
      return { status: "stopped", realmId: batch.realmId, completedCount: index, results,
        instruction: "Completed writes remain posted. Verify the failed record before retrying; a network failure can leave its outcome uncertain. Prepare and approve a new batch only for remaining changes." };
    }
  }
  return { status: "executed", realmId: batch.realmId, completedCount: results.length, results };
}

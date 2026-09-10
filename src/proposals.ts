import { decryptJson, encryptJson } from "./crypto.js";
import { qboRequest } from "./intuit.js";
import { getActiveConnection } from "./store.js";
import { sql } from "./db.js";

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
    confirmation: `CONFIRM ${id}`,
    expiresAt: new Date(rows[0].expires_at).toISOString(),
    summary: {
      operation: input.operation,
      entity: input.entity,
      realmId: connection.realmId,
      recordId: input.id ?? null,
      payloadFields: Object.keys(normalized).sort(),
    },
  };
}

export async function executeWrite(input: { userId: string; proposalId: string; confirmation: string }) {
  if (input.confirmation !== `CONFIRM ${input.proposalId}`) {
    throw new Error(`Confirmation mismatch. The exact phrase must be: CONFIRM ${input.proposalId}`);
  }
  const db = sql();
  const proposal = await db.begin(async (tx) => {
    const rows = await tx`
      select id, realm_id, operation, entity, encrypted_payload, status, expires_at
      from qbo_write_proposals
      where id = ${input.proposalId} and user_id = ${input.userId}
      for update
    `;
    if (rows.length !== 1) throw new Error("Write proposal not found");
    const row = rows[0];
    if (row.status !== "prepared") throw new Error(`Write proposal cannot run from status: ${row.status}`);
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error("Write proposal expired; prepare a new one");
    await tx`
      update qbo_write_proposals set status = 'executing'
      where id = ${input.proposalId}
    `;
    return {
      realmId: String(row.realm_id),
      operation: String(row.operation) as WriteOperation,
      entity: String(row.entity),
      payload: decryptJson<Record<string, unknown>>(String(row.encrypted_payload)),
    };
  });

  const connection = await getActiveConnection(input.userId);
  if (connection.realmId !== proposal.realmId) {
    await db`update qbo_write_proposals set status = 'failed', error_code = 'realm_changed' where id = ${input.proposalId}`;
    throw new Error("The active QuickBooks company changed after approval; prepare a new write proposal");
  }

  const endpoint = proposal.entity.toLowerCase();
  const query: Record<string, string> = { requestid: input.proposalId };
  if (proposal.operation === "delete" || proposal.operation === "void") query.operation = proposal.operation;

  try {
    const result = await qboRequest(input.userId, endpoint, {
      method: "POST",
      body: JSON.stringify(proposal.payload),
    }, query);
    const body = result.data as Record<string, any>;
    const record = body?.[proposal.entity] ?? body;
    const resultId = record?.Id ? String(record.Id) : null;
    await db`
      update qbo_write_proposals
      set status = 'executed', executed_at = now(), result_id = ${resultId}
      where id = ${input.proposalId}
    `;
    return { proposalId: input.proposalId, status: "executed", realmId: result.realmId, result: result.data };
  } catch (error) {
    await db`
      update qbo_write_proposals set status = 'failed', error_code = 'qbo_request_failed'
      where id = ${input.proposalId}
    `;
    throw error;
  }
}

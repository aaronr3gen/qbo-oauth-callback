import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { encryptJson } from "../src/crypto.js";
import { resetConfigForTests } from "../src/config.js";
import { executeWrite, executeWriteBatch, prepareWriteBatch, requireApproval, signBatch, validateBatch, verifyBatch, type WriteRuntime } from "../src/proposals.js";

Object.assign(process.env, {
  QBO_CLIENT_ID: "test", QBO_CLIENT_SECRET: "test", QBO_REDIRECT_URI: "https://example.test/callback",
  QBO_ENVIRONMENT: "sandbox", DATABASE_URL: "postgres://example.test/db",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), CONNECT_STATE_SECRET: randomBytes(48).toString("base64"),
  AUTH0_ISSUER_BASE_URL: "https://example.auth0.com/", AUTH0_AUDIENCE: "https://example.test",
  QBO_MCP_RESOURCE: "https://example.test", QBO_PUBLIC_BASE_URL: "https://example.test",
});
resetConfigForTests();

type Row = { id: string; user_id: string; realm_id: string; operation: string; entity: string;
  encrypted_payload: string; status: string; expires_at: Date; error_code?: string };

// Deterministic repository adapter. No database, credentials or QBO calls.
function fixture(count = 3) {
  let rows: Row[] = Array.from({ length: count }, () => ({ id: randomUUID(), user_id: "alice", realm_id: "company-a",
    operation: "create", entity: "Invoice", encrypted_payload: encryptJson({ TotalAmt: 12 }),
    status: "prepared", expires_at: new Date(Date.now() + 600_000) }));
  let queue = Promise.resolve();
  const query = async (strings: TemplateStringsArray | string[], ...inputs: unknown[]): Promise<unknown> => {
    if (!Array.isArray(strings) || !("raw" in strings)) return strings;
    const values = await Promise.all(inputs);
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into")) {
      const row: Row = { id: randomUUID(), user_id: String(values[0]), realm_id: String(values[1]),
        operation: String(values[2]), entity: String(values[3]), encrypted_payload: String(values[4]),
        status: "prepared", expires_at: new Date(Date.now() + 600_000) };
      rows.push(row); return [{ id: row.id, expires_at: row.expires_at }];
    }
    if (text.startsWith("select")) {
      const ids = values[0] as string[];
      return rows.filter((r) => ids.includes(r.id) && r.user_id === values[1]);
    }
    if (text.includes("set status = 'executing'")) {
      for (const row of rows) if ((values[0] as string[]).includes(row.id) && row.user_id === values[1]) row.status = "executing";
    } else if (text.includes("status = 'executed'")) {
      for (const row of rows) if (row.id === values[1] && row.user_id === values[2]) row.status = "executed";
    } else if (text.includes("batch_stopped")) {
      for (const row of rows) if ((values[0] as string[]).includes(row.id) && row.user_id === values[1] && row.status === "executing") row.status = "failed";
    } else if (text.includes("qbo_request_failed")) {
      for (const row of rows) if (row.id === values[0] && row.user_id === values[1]) row.status = "failed";
    } else throw new Error(`Unexpected fixture query: ${text}`);
    return [];
  };
  const db = Object.assign(query, { begin: async (fn: (tx: typeof query) => Promise<unknown>) => {
    const before = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await before;
    const snapshot = structuredClone(rows);
    try { return await fn(db); } catch (error) { rows = snapshot; throw error; } finally { release(); }
  } });
  const calls: string[] = [];
  let activeRealm = "company-a";
  let failAt = -1;
  const services: WriteRuntime = {
    db: db as unknown as WriteRuntime["db"],
    connection: async () => ({ userId: "alice", realmId: activeRealm, displayName: "Test company", tokens: { accessToken: "test", refreshToken: "test", tokenType: "bearer" }, accessTokenExpiresAt: new Date(), refreshTokenExpiresAt: null }),
    request: async (_user, _path, _init, params, expectedRealm) => {
      assert.equal(expectedRealm, "company-a");
      if (activeRealm !== expectedRealm) throw new Error("Company changed");
      calls.push(params!.requestid);
      if (calls.length === failAt) throw new Error("QBO failed");
      return { realmId: expectedRealm!, data: { Invoice: { Id: String(calls.length) } } };
    },
  };
  return { services, calls, rows: () => rows, changeCompany: () => { activeRealm = "company-b"; }, failAt: (n: number) => { failAt = n; } };
}

test("normal approval needs no code; destructive writes require separate approval", () => {
  assert.doesNotThrow(() => requireApproval(true, "create"));
  assert.throws(() => requireApproval(false), /approval/);
  assert.throws(() => requireApproval(true, "delete"), /separate/);
  assert.doesNotThrow(() => requireApproval(true, "void", true));
});

test("batch refuses empty, excessive and destructive changes before preparation", () => {
  assert.throws(() => validateBatch([]));
  assert.throws(() => validateBatch(Array(51).fill({ operation: "create", entity: "Invoice", payload: {} })));
  assert.throws(() => validateBatch([{ operation: "delete", entity: "Invoice", payload: {}, id: "1", syncToken: "1" }]));
});

test("batch signature binds exact proposal list and user; refuses tampering and expiry", async () => {
  const token = await signBatch("alice", "company-a", [randomUUID()]);
  assert.equal((await verifyBatch("alice", token)).realmId, "company-a");
  await assert.rejects(verifyBatch("bob", token));
  const pieces = token.split("."); pieces[1] = Buffer.from(JSON.stringify({ sub: "bob" })).toString("base64url");
  await assert.rejects(verifyBatch("bob", pieces.join(".")));
  const expired = await new SignJWT({ realmId: "company-a", proposalIds: [randomUUID()] }).setProtectedHeader({ alg: "HS256" })
    .setSubject("alice").setIssuer("https://example.test").setAudience("qbo-write-batch").setExpirationTime(1)
    .sign(new TextEncoder().encode(process.env.CONNECT_STATE_SECRET));
  await assert.rejects(verifyBatch("alice", expired));
});

test("preparation returns complete review without posting; one approval executes the exact batch once", async () => {
  const f = fixture(0);
  const prepared = await prepareWriteBatch({ userId: "alice", writes: [
    { operation: "create", entity: "Invoice", payload: { TotalAmt: 12, TxnDate: "2026-10-08" } },
    { operation: "update", entity: "Invoice", payload: { PrivateNote: "Reviewed" }, id: "7", syncToken: "2" },
  ] }, f.services);
  assert.equal(f.calls.length, 0);
  assert.equal(prepared.count, 2);
  assert.equal(prepared.companyName, "Test company");
  assert.equal(prepared.proposals[0].payload.TotalAmt, 12);
  assert.equal(prepared.proposals[1].payload.SyncToken, "2");
  await assert.rejects(executeWriteBatch({ userId: "alice", batchToken: prepared.batchToken, approved: false }, f.services));
  const result = await executeWriteBatch({ userId: "alice", batchToken: prepared.batchToken, approved: true }, f.services);
  assert.equal(result.completedCount, 2);
  assert.deepEqual(f.calls, prepared.proposals.map((p) => p.proposalId));
  await assert.rejects(executeWriteBatch({ userId: "alice", batchToken: prepared.batchToken, approved: true }, f.services));
  assert.equal(f.calls.length, 2);
});

test("batch stops on first failure and records completed and unattempted rows", async () => {
  const f = fixture(); f.failAt(2);
  const token = await signBatch("alice", "company-a", f.rows().map((r) => r.id));
  const result = await executeWriteBatch({ userId: "alice", batchToken: token, approved: true }, f.services);
  assert.equal(result.status, "stopped"); assert.equal(result.completedCount, 1);
  assert.deepEqual(result.results.map((r) => r.status), ["executed", "failed", "not_attempted"]);
  assert.deepEqual(f.rows().map((r) => r.status), ["executed", "failed", "failed"]);
  assert.equal(f.calls.length, 2);
});

test("company change and wrong owner cannot post; expiry rolls back the entire claim", async () => {
  const f = fixture();
  const token = await signBatch("alice", "company-a", f.rows().map((r) => r.id));
  await assert.rejects(executeWrite({ userId: "bob", proposalId: f.rows()[0].id, approved: true }, f.services));
  f.rows()[1].expires_at = new Date(0);
  await assert.rejects(executeWriteBatch({ userId: "alice", batchToken: token, approved: true }, f.services));
  assert.ok(f.rows().every((r) => r.status === "prepared"));
  f.rows()[1].expires_at = new Date(Date.now() + 600_000);
  f.changeCompany();
  const stopped = await executeWriteBatch({ userId: "alice", batchToken: token, approved: true }, f.services);
  assert.equal(stopped.completedCount, 0); assert.equal(f.calls.length, 0);
});

test("concurrent batch execution claims each proposal once", async () => {
  const f = fixture(); const token = await signBatch("alice", "company-a", f.rows().map((r) => r.id));
  const results = await Promise.allSettled([1, 2].map(() => executeWriteBatch({ userId: "alice", batchToken: token, approved: true }, f.services)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.length, 3);
});

test("delete execution refuses general approval and accepts separate record approval", async () => {
  const f = fixture(1); f.rows()[0].operation = "delete";
  await assert.rejects(executeWrite({ userId: "alice", proposalId: f.rows()[0].id, approved: true }, f.services), /separate/);
  assert.equal(f.rows()[0].status, "prepared");
  await executeWrite({ userId: "alice", proposalId: f.rows()[0].id, approved: true, destructiveApproved: true }, f.services);
  assert.equal(f.calls.length, 1);
});

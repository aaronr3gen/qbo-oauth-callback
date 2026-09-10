import assert from "node:assert/strict";
import test from "node:test";
import { validateWrite } from "../src/proposals.js";

test("create rejects explicit ids", () => {
  assert.throws(() => validateWrite("create", "Invoice", { payload: { Id: "1" } }));
});

test("update requires optimistic-lock fields and forces sparse update", () => {
  assert.throws(() => validateWrite("update", "Invoice", { payload: {} }));
  assert.deepEqual(
    validateWrite("update", "Invoice", { payload: { PrivateNote: "Approved" }, id: "10", syncToken: "2" }),
    { PrivateNote: "Approved", Id: "10", SyncToken: "2", sparse: true },
  );
});

test("delete allowlist prevents deleting list entities", () => {
  assert.throws(() => validateWrite("delete", "Customer", { payload: {}, id: "7", syncToken: "1" }));
  assert.deepEqual(
    validateWrite("delete", "Bill", { payload: {}, id: "7", syncToken: "1" }),
    { Id: "7", SyncToken: "1" },
  );
});

test("void is limited to supported transaction entities", () => {
  assert.throws(() => validateWrite("void", "Bill", { payload: {}, id: "7", syncToken: "1" }));
  assert.deepEqual(
    validateWrite("void", "Invoice", { payload: {}, id: "7", syncToken: "1" }),
    { Id: "7", SyncToken: "1" },
  );
});

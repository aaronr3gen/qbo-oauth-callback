import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createQboMcpServer } from "../src/server.js";

test("MCP advertises the bounded tool surface and destructive execution hint", async () => {
  const server = createQboMcpServer({
    subject: "test-user",
    scopes: new Set(["qbo:read", "qbo:write"]),
    claims: {},
  });
  const client = new Client({ name: "metadata-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name), [
      "qbo_list_companies",
      "qbo_create_connection_link",
      "qbo_select_company",
      "qbo_get_record",
      "qbo_query_records",
      "qbo_run_report",
      "qbo_prepare_write",
      "qbo_execute_write",
    ]);
    const execute = result.tools.find((tool) => tool.name === "qbo_execute_write");
    assert.equal(execute?.annotations?.readOnlyHint, false);
    assert.equal(execute?.annotations?.destructiveHint, true);
  } finally {
    await client.close();
    await server.close();
  }
});

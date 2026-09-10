import postgres from "postgres";
import { getConfig } from "./config.js";

type SqlClient = ReturnType<typeof postgres>;

let client: SqlClient | undefined;

export function sql(): SqlClient {
  if (!client) {
    client = postgres(getConfig().databaseUrl, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      ssl: "require",
    });
  }
  return client;
}

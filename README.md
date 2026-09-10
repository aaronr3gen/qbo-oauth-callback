# QuickBooks Online remote MCP

Production-oriented QuickBooks Online Accounting tools for ChatGPT and Codex. The service runs as stateless Streamable HTTP on Vercel, uses Auth0 for MCP user authentication, and stores Intuit OAuth tokens encrypted in Postgres.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/mcp` | Authenticated Streamable HTTP MCP endpoint |
| `GET /.well-known/oauth-protected-resource` | MCP OAuth protected-resource metadata |
| `GET /api/qbo/connect?ticket=...` | One-time handoff into Intuit OAuth |
| `GET /api/qbo/callback` | Intuit OAuth callback and server-side code exchange |
| `GET /api/health` | Liveness check; no accounting data |

The checked-in plugin points to `https://qbo-oauth-callback-orcin.vercel.app/api/mcp`. The already registered Intuit production callback remains:

`https://qbo-oauth-callback-orcin.vercel.app/api/qbo/callback`

The other registered redirects can remain during migration. Do not use the `trycloudflare.com` callback for production because temporary tunnel hostnames are not stable.

## Security model

- ChatGPT authenticates to the MCP resource through an Auth0 OAuth 2.1 authorization server.
- Every MCP request validates the JWT signature, issuer, audience, expiry, and scopes.
- Intuit client credentials exist only in Vercel encrypted environment variables.
- Intuit access and refresh tokens are encrypted with AES-256-GCM before Postgres storage.
- Refresh is serialized with a database row lock, preventing concurrent use of the same rotating Intuit refresh token.
- QuickBooks connection links are signed, one-time, and expire after 10 minutes.
- Writes are staged first. Execution requires a fresh proposal Id and its exact confirmation phrase.
- The execution tool is advertised as destructive so ChatGPT can require an additional approval.
- Error pages and logs do not include OAuth codes, access tokens, refresh tokens, or database credentials.

## QBO tools

- `qbo_list_companies`
- `qbo_create_connection_link`
- `qbo_select_company`
- `qbo_get_record`
- `qbo_query_records`
- `qbo_run_report`
- `qbo_prepare_write`
- `qbo_execute_write`

The generic read tools cover common Accounting API entities and reports. Writes support create/update for common entities and tightly restrict delete/void operations. QuickBooks still performs its own entity-specific schema and `SyncToken` validation.

## 1. Create the database

Create a Neon or Vercel Postgres database in the same Vercel project/region. Run [`db/migrations/001_init.sql`](db/migrations/001_init.sql) once in the provider's SQL console.

Use a dedicated database role for the application. Grant only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the three `qbo_*` tables after the migration is applied.

## 2. Configure Auth0

Use Auth0 as the authorization server for the MCP resource:

1. Create an Auth0 API with identifier `https://qbo-oauth-callback-orcin.vercel.app`.
2. Add permissions `qbo:read` and `qbo:write`.
3. Create/configure the OAuth client ChatGPT will use. In the ChatGPT plugin management page, copy the exact client metadata/redirect values ChatGPT shows into Auth0. Do not guess the callback URL.
4. Enable authorization-code flow with PKCE (`S256`) and make sure the Auth0 discovery document is public.
5. Grant `qbo:write` only to identities that should be able to stage and execute accounting changes.

The MCP protected-resource metadata points ChatGPT to the Auth0 issuer. The audience in the Auth0 access token must exactly match `QBO_MCP_RESOURCE`.

## 3. Configure Vercel secrets

Open the `qbo-oauth-callback` Vercel project, then go to **Settings → Environment Variables**. Add the variables below to Production and Preview as appropriate. Never paste them into ChatGPT, commit them, or place them in plugin configuration.

| Exact name | Location/value |
| --- | --- |
| `QBO_CLIENT_ID` | Intuit Developer → app → Production keys |
| `QBO_CLIENT_SECRET` | Intuit Developer → app → Production keys |
| `QBO_REDIRECT_URI` | `https://qbo-oauth-callback-orcin.vercel.app/api/qbo/callback` |
| `QBO_ENVIRONMENT` | `production` |
| `QBO_MINOR_VERSION` | `75` initially; change only after API compatibility testing |
| `DATABASE_URL` | Neon/Vercel Postgres pooled TLS connection string |
| `TOKEN_ENCRYPTION_KEY` | Base64-encoded 32-byte key; generate locally with `openssl rand -base64 32` |
| `TOKEN_ENCRYPTION_KEY_VERSION` | `1` |
| `CONNECT_STATE_SECRET` | Random secret of at least 32 bytes; generate locally with `openssl rand -base64 48` |
| `AUTH0_ISSUER_BASE_URL` | Auth0 tenant issuer, including trailing slash |
| `AUTH0_AUDIENCE` | `https://qbo-oauth-callback-orcin.vercel.app` |
| `QBO_MCP_RESOURCE` | `https://qbo-oauth-callback-orcin.vercel.app` |
| `QBO_PUBLIC_BASE_URL` | `https://qbo-oauth-callback-orcin.vercel.app` |

After adding/changing secrets, redeploy. Vercel encrypts environment variable values at rest and injects them only into the function runtime.

## 4. Intuit production settings

Keep the existing Vercel redirect URI. Once the consolidated service is verified, consider removing the temporary Cloudflare tunnel URI. The OAuth playground URI is useful for manual diagnostics but should not be used by this service.

Because a credential-bearing `.env` was previously tracked in `aaronr3gen/qbo-mcp-server`, rotate the Intuit production client secret and revoke/reconnect any exposed refresh token before enabling writes. Removing the file from the current branch is not enough to remove it from Git history.

## 5. Deploy and test

1. Import this repository into Vercel or use the existing linked project.
2. Apply the database migration and add all environment variables.
3. Deploy and confirm `/api/health` returns `{ "ok": true }`.
4. Confirm `/.well-known/oauth-protected-resource` returns the expected Auth0 issuer and audience.
5. Run MCP Inspector against `https://qbo-oauth-callback-orcin.vercel.app/api/mcp`.
6. In ChatGPT, enable Developer mode, add the HTTPS MCP endpoint, finish Auth0 linking, and review discovered tool annotations.
7. Call `qbo_create_connection_link`, open it, and authorize the correct QBO company.
8. Test reads first. Test writes only in an Intuit sandbox until the prepare/approve/execute flow is verified end to end.

## Local checks

```bash
npm install
npm run check
python3 /Users/personal/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/quickbooks-online
```

No live QuickBooks call is made by the test suite.

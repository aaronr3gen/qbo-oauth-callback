# Security policy

## Secrets

Never commit Intuit credentials, Auth0 secrets, database URLs, encryption keys, OAuth codes, or tokens. Store runtime secrets only in Vercel encrypted environment variables. Store Intuit tokens only through the encrypted `qbo_connections` table.

If a secret reaches Git history, rotate or revoke it immediately. Deleting the current file does not invalidate the exposed value.

## Write controls

QuickBooks write operations use preparation and execution. A preparation call stores an encrypted proposal for 10 minutes and returns the full review. Execution requires explicit normal-language user approval, represented by the MCP client's `approved: true` assertion. The server does not independently verify a human conversation. Keep client tool approval controls enabled.

A signed batch token binds one user, one company and an immutable ordered list of up to 50 create/update proposals. The database claims all proposals together and refuses missing, expired, wrong-user or previously claimed proposals. The API request verifies the approved company against the connection used to send the write, preventing a concurrent company selection from redirecting a write.

Deletes and voids cannot be batched. Each requires separate approval and `destructiveApproved: true`. Execution refuses replay after a proposal leaves `prepared` state.

A batch stops on its first error. Successful writes remain posted. Failed or interrupted requests can have uncertain QuickBooks outcomes. Reconcile before retrying. A process termination can leave proposal status `executing`; do not silently reset or reuse that proposal.

## Reporting

Do not include live credentials or accounting data in an issue. Report vulnerabilities privately to the repository owner.

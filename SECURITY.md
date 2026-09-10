# Security policy

## Secrets

Never commit Intuit credentials, Auth0 secrets, database URLs, encryption keys, OAuth codes, or tokens. Store runtime secrets only in Vercel encrypted environment variables. Store Intuit tokens only through the encrypted `qbo_connections` table.

If a secret reaches Git history, rotate or revoke it immediately. Deleting the current file does not invalidate the exposed value.

## Write controls

QuickBooks write operations are deliberately two-step. A preparation call stores an encrypted proposal for 10 minutes. Execution requires the exact confirmation phrase, verifies that the active realm has not changed, and refuses replay after the proposal leaves `prepared` state.

## Reporting

Do not include live credentials or accounting data in an issue. Report vulnerabilities privately to the repository owner.

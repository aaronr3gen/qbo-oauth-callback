---
name: quickbooks-online
description: Read QuickBooks Online accounting data and prepare approval-gated changes through the hosted QuickBooks MCP server.
---

# QuickBooks Online

Use the QuickBooks Online MCP tools for company data, reports, and accounting changes.

## Connection

1. Call `qbo_list_companies` first when company context is unclear.
2. If no company is connected, call `qbo_create_connection_link` and ask the user to open the returned one-time URL.
3. If more than one company is present, confirm the intended company before calling `qbo_select_company`.

## Reads

- Use `qbo_get_record` for an exact entity Id.
- Use `qbo_query_records` for filtered lists and pagination.
- Use `qbo_run_report` for standard accounting reports.
- Do not infer that an empty result means the record never existed.

## Writes

1. INPUT: The user's requested change and intended company. ACTION: Call `qbo_prepare_write` for one change, or `qbo_prepare_write_batch` for 1 to 50 creates/updates. EXPECTED OUTPUT: Stored proposals and the complete review. CONSTRAINT: Preparation does not modify QuickBooks. Delete and void must use individual proposals.
2. SOURCE OF TRUTH: The preparation response. ACTION: Show the company and every proposed record, date, account, amount and changed value. Keep proposal identifiers and batch tokens internal. APPROVAL REQUIREMENT: Obtain an explicit user reply such as "Approve" or "Post these changes" after the review. Never ask the user to type a code. Never infer approval from preparation.
3. ACTION: Call `qbo_execute_write` or `qbo_execute_write_batch` with the unchanged internal identifier/token and `approved: true`. CONSTRAINT: Execute only the exact reviewed changes. Each delete or void requires separate approval for the specific record and `destructiveApproved: true`.
4. STOP CONDITION: Any change to the payload, company or batch, or proposal expiry. ACTION: Prepare and show a new review. APPROVAL REQUIREMENT: Obtain new approval. Proposals expire after 10 minutes and execute at most once.
5. STOP CONDITION: Failed, interrupted or partial execution. ACTION: Report completed, failed and unattempted items. Completed writes remain posted. Check the failed item's QuickBooks outcome before any retry. Never replay an entire batch or silently reset an `executing` proposal.

Do not request API keys, client secrets, refresh tokens, or database credentials in chat.

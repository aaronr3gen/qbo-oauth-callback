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

All QuickBooks changes use two steps:

1. Call `qbo_prepare_write`. This validates and stores the proposed change without modifying QuickBooks.
2. Present the returned summary to the user. Call `qbo_execute_write` only after the user explicitly approves that summary and provides the exact confirmation phrase returned by the preparation step.

Never invent, shorten, or reuse a confirmation phrase. A proposal expires after 10 minutes and can execute only once. If the active company changes, prepare a new proposal.

Do not request API keys, client secrets, refresh tokens, or database credentials in chat.

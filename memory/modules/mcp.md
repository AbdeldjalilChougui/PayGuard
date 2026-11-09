---
tags:
  - memory
  - module
  - payguard
last_updated: 2026-11-09
related_files:
  - "mcp/server.ts"
---

# MCP

**Purpose:** stdio MCP server so any MCP client can shop with the demo agent's key.

## Main functions / classes
- Tools: `search_vendors`, `buy(url)`, `budget_status`
- Add: `claude mcp add payguard -- pnpm --dir <repo> mcp`; `PAYGUARD_VAULT` overrides the vault

## Dependencies
- Uses: [[sdk]], [[server]] env/config

See also: [[decisions]], [[architecture]]

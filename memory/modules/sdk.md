---
tags:
  - memory
  - module
  - payguard
last_updated: 2026-11-09
related_files:
  - "sdk/src/agent.ts"
  - "sdk/src/vendor.ts"
  - "sdk/src/program.ts"
  - "sdk/src/crank.ts"
---

# SDK

**Purpose:** `@payguard/sdk`, isomorphic (Node + browser), used by server, MCP, scripts and web.

## Key files
- `program.ts` — IDL, PDAs, fetchers, `reputation`, `RULE_TEXT`, `parseError`
- `agent.ts` — `PayGuardAgent.fetch(url)`: 402 → escrow → verify receipt → accept/dispute/refund
- `vendor.ts` — `paywall(opts, handler)`, `verifyPayment`, `postReceipt`, `invoice`
- `crank.ts` — `crankOnce`, `startCrank`; `tx.ts` — `send` (audit = skipPreflight)
- `x402.ts` — payment messages and base64 headers

## Dependencies
- Uses: [[program]] IDL in `sdk/src/idl/`
- Used by: [[server]], [[mcp]], [[web]], [[scripts]]

## Gotchas
> [!warning]
> No `Buffer` and no constructor parameter properties: the web build (polyfills, erasableSyntaxOnly) breaks on them.

See also: [[decisions]], [[architecture]]

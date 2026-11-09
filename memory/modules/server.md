---
tags:
  - memory
  - module
  - payguard
last_updated: 2026-11-09
related_files:
  - "server/index.ts"
  - "server/agent.ts"
  - "server/vendors.ts"
  - "server/catalog.ts"
  - "server/env.ts"
---

# Server

**Purpose:** the whole backend in one Node service (fits one free Render web service).

## Key files
- `index.ts` — routes `/v/*`, `/agent/run`, `/agent/attack` (NDJSON), `/faucet`, `/health`; starts the crank
- `agent.ts` — Gemini agent (search_vendors, http_get, budget_status) and `runAttack`
- `vendors.ts` — demo vendors; `catalog.ts` — vendor list, demo rules
- `env.ts` — env, RPC, keys (`PAYGUARD_KEYS` or `KEYS_DIR`), config
- `cli.ts` — `pnpm agent "<task>"` / `pnpm agent attack`

## Dependencies
- Uses: [[sdk]]; Used by: [[web]], [[scripts]] (e2e)

## Gotchas
> [!warning]
> One run at a time and AGENT_RUNS_PER_HOUR cap. Gemini free tier ~20 req/day/model; GEMINI_MODEL is a fallback list. The faucet spends the demo owner's SOL.

See also: [[decisions]], [[architecture]]

---
tags:
  - memory
  - module
  - payguard
last_updated: 2026-11-09
related_files:
  - "scripts/setup.ts"
  - "scripts/reset-demo.ts"
  - "scripts/e2e.ts"
  - "scripts/keys-export.ts"
---

# Scripts

**Purpose:** devnet bootstrapping, demo reset, tests, deploy helpers.

## Key files
- `setup.ts` — demo owner (funded from the deploy wallet), mint, vendors (updates URLs on re-run), vault, agent, config
- `reset-demo.ts` — new agent key on the same vault, unpauses
- `e2e.ts` — 9 devnet checks through a running server (`E2E_BASE`)
- `keys-export.ts` — prints `PAYGUARD_KEYS` for Render

## Dependencies
- Uses: [[sdk]], [[server]] env/catalog

## Gotchas
> [!warning]
> After `demo:reset`, re-export keys to Render and push the config. Never commit `.keys/`.

See also: [[decisions]], [[architecture]]

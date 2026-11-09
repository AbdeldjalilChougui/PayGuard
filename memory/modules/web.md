---
tags:
  - memory
  - module
  - payguard
last_updated: 2026-11-09
related_files:
  - "web/src/App.tsx"
  - "web/src/components/VaultDashboard.tsx"
  - "web/src/components/Marketplace.tsx"
  - "web/src/lib/pg.ts"
---

# Web

**Purpose:** dashboard: home, live demo vault, marketplace, create vault, owner controls.

## Key files
- `App.tsx` — routes `?vault=`, `?page=market`, home
- `components/VaultDashboard.tsx` — stats, escrows, agent budgets, owner panel
- `components/AgentConsole.tsx` — 6 scenes, streams from the server
- `components/CreateVault.tsx` — one-tx vault + deposit + agent; `VendorPicker`
- `lib/pg.ts` — config, activity feed from events and failed txs
- `hooks/useVendors.ts` — shared, de-duplicated vendor listing

## Dependencies
- Uses: [[sdk]], [[server]] (`VITE_API_URL`)

## Gotchas
> [!warning]
> Old SolWarden dev servers may still hold ports 5173/4001/4002; PayGuard web was tested on 5180. Free Helius devnet is sometimes slow on getProgramAccounts.

See also: [[decisions]], [[architecture]]

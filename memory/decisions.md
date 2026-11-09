---
tags:
  - memory
  - decisions
  - payguard
last_updated: 2026-11-09
---

# Decisions

Newest first. One entry per decision: what, why, what was rejected.

## 2026-11-09 — Render free plan, keys in one env var
- **Decision:** `render.yaml` with a static site + one Node web service; demo keys via `PAYGUARD_KEYS` (from `pnpm keys:export`).
- **Why:** user asked for Render instead of a VPS; one var beats 12 Secret Files. Deploy wallet never leaves the machine (setup creates a separate demo owner).
- **Rejected:** VPS; Netlify (no long-running server).
- Affects: [[server]], [[scripts]]

## 2026-11-09 — Escrow inside the vault, not separate token accounts
- **Decision:** escrowed money stays in the vault ATA; `vault.locked` tracks it and `withdraw` only takes free funds.
- **Why:** no token account rent per purchase; vendor is still guaranteed payment.
- Affects: [[program]]

## 2026-11-09 — Optimistic disputes
- **Decision:** agent's dispute refunds; cost to vendor is on-chain reputation.
- **Why:** the chain cannot read HTTP; arbitration is out of scope. Receipt hash binds the vendor to the exact body.
- **Rejected:** oracle/arbiter, vendor staking (future work).

## 2026-11-09 — Listed price check
- **Decision:** `open_escrow` rejects amounts above `vendor.price` (OverListedPrice).
- **Why:** overcharge is stopped by the marketplace listing, independent of the cap.

## 2026-11-09 — Fork SolWarden as PayGuard with a new program id
- **Decision:** copy, rename, new keypair.
- **Why:** SolWarden stays frozen as the MLH submission; reusing its id would upgrade the live program.

## 2026-11-08 — Rules live on-chain, the agent stays naive; devnet only
- **Why:** safety must hold when the model is fooled or the key is stolen. Algeria Law 25-10: no real funds.

Back to [[index]]

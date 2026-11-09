---
tags:
  - memory
  - module
  - payguard
last_updated: 2026-11-09
related_files:
  - "programs/payguard/src/lib.rs"
  - "programs/payguard/src/state.rs"
  - "programs/payguard/tests/escrow.rs"
---

# Program

**Purpose:** Anchor program: vault, agent rules, vendor listings, escrow.

## Key files
- `src/state.rs` — accounts, seeds, events; `src/error.rs` — GuardError
- `src/lib.rs` — instructions and account contexts
- `tests/escrow.rs` — LiteSVM tests with clock warp (`pnpm test:program`)

## Main functions / classes
- Owner: `create_vault`, `deposit`, `withdraw`, `set_vault_paused`, `update_vault_timing`, `add_agent`, `update_agent`, `set_agent_paused`
- Vendor: `register_vendor`, `update_vendor`, `post_receipt`
- Agent: `open_escrow` (checks paused → approved → active/mint → listed price → cap → daily → vendor budget → free funds), `accept`, `dispute`
- Anyone: `release`, `refund_expired`

## Dependencies
- Used by: [[sdk]]

## Gotchas
> [!warning]
> Anchor builds SBPF v3, which LiteSVM 0.10 cannot load: tests use a v0 build in `target/test-sbf` (tools v1.57). After program changes: `anchor build`, `anchor deploy --provider.cluster devnet`, `pnpm sync:idl`. Deploy costs ~1.7 devnet SOL.

See also: [[decisions]], [[architecture]]

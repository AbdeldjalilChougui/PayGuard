---
tags:
  - memory
  - index
  - payguard
last_updated: 2026-11-09
---

# PayGuard

Safe shopping for AI agents on Solana: marketplace (vendor reputation) + firewall (owner rules) + escrow (refunds) in one program, sold over x402. Devnet only. Forked from SolWarden on 2026-11-09.

## Stack
- Anchor 1.2 program (Rust), LiteSVM tests
- TypeScript workspace: `@payguard/sdk`, one Node server, MCP server, scripts
- Gemini agent via Interactions API (REST)
- Web: Vite + React + Tailwind + Solana wallet adapter
- Hosting: Render free plan (`render.yaml`)

## Map
- [[architecture]] — how the parts fit together
- [[decisions]] — why things were built this way
- [[log]] — recent changes, newest first
- [[modules]] — base view of all module notes

## Modules
- [[program]] — Vault, AgentPolicy, Vendor, Escrow; rules and escrow lifecycle
- [[sdk]] — PDAs, reads, agent fetch, vendor paywall, crank, x402 types
- [[server]] — demo vendors, Gemini agent, faucet, crank; one Render service
- [[mcp]] — MCP tools for any MCP client
- [[web]] — dashboard, marketplace, create vault, scenes
- [[scripts]] — setup, demo reset, e2e, key export

## To revisit
- Not committed yet; not deployed to Render yet
- Vendor URLs on-chain point at localhost until setup is re-run with PUBLIC_BASE_URL
- Future: vendor staking/slashing, Token-2022, per-vendor time windows

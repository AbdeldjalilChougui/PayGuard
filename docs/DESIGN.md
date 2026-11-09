# PayGuard design

PayGuard lets AI agents find, pay for and get refunds from paid APIs, inside
limits their owner sets on-chain. Three layers, one Solana program:

| Layer | Question | Accounts |
|---|---|---|
| Marketplace | Who can I buy from? | `Vendor` |
| Firewall | Am I allowed to spend this? | `Vault`, `AgentPolicy` |
| Escrow | Did I get what I paid for? | `Escrow` |

## Accounts

| Account | Seeds | Holds |
|---|---|---|
| `Vault` | `["vault", owner, mint]` | owner, mint, paused, `locked` (sum of open escrows), receipt timeout, dispute window. Its ATA holds the money. |
| `AgentPolicy` | `["agent", vault, agent]` | per-payment cap, daily limit, spent today, paused, up to 8 vendor rules `{vendor, daily_cap, spent_today}` |
| `Vendor` | `["vendor", authority]` | pay-to wallet, name, URL, listed price, mint, active, and the reputation counters: sales, delivered, refunded, disputed, revenue |
| `Escrow` | `["escrow", agent_policy, nonce]` | vendor, amount, deadline, dispute end, status, receipt hash |

Escrowed money never leaves the vault until release. The vault tracks it as
`locked`, and the owner can only withdraw `balance - locked`, so a vendor that
delivered is guaranteed to be paid.

## Lifecycle of one purchase

1. Agent calls a vendor URL and gets `402` with an invoice
   (`scheme: "payguard-escrow"`, amount, vendor, mint, 16-byte nonce).
2. Agent sends `open_escrow(amount, nonce)`. The program checks, in order:
   vault and agent not paused, vendor active, vendor on the agent's rules,
   amount <= the vendor's **listed price**, amount <= per-payment cap, daily
   limit, the vendor's own daily budget. Then it locks the amount.
3. Agent retries with `X-PAYMENT: {escrow, signature}`.
4. Vendor checks the escrow on-chain (its vendor, amount, nonce, `Locked`),
   builds the response, sends `post_receipt(sha256(body))` and returns the body.
   `post_receipt` only works on a `Locked` escrow, so a payment cannot be
   reused.
5. Agent checks `sha256(body)` against the receipt and validates the content:
   good → `accept` (vendor paid now); bad → `dispute` (refund, vendor's
   `disputed` count goes up).
6. Nobody acts: `release` (anyone, after the dispute window) pays the vendor;
   `refund_expired` (anyone, after the receipt deadline with no receipt)
   refunds the vault. The server runs a crank that calls both.

Refunds give the amount back to the agent's daily budget and the vendor rule's
budget when the escrow was opened in the current day window.

## Threat model (what the demo shows)

| Attack | Stopped by |
|---|---|
| Lookalike vendor (cheaper, other wallet) | vendor not in the agent's rules |
| Invoice above the listed price | `OverListedPrice` |
| Billing loop | per-vendor daily budget, then the agent daily limit |
| Vendor takes the money, never delivers | `refund_expired` after the deadline |
| Vendor delivers junk | agent `dispute` within the window |
| Stolen agent key | rules, caps; money only reaches vendors that deliver; owner `Pause` |

**Limits.** The chain cannot read HTTP responses. Disputes are optimistic: the
agent's word decides, and the cost to a vendor is reputation, not arbitration.
Vendor staking and slashing are future work. Devnet only.

## Off-chain parts

- `sdk/` — TypeScript client: PDAs, instruction builders, `guardedFetch()` for
  agents, `paywall()` Express middleware for vendors, the crank.
- `server/` — one Node service: demo vendors, the agent (`/agent/run`,
  `/agent/attack`), faucet, crank. Keys come from `KEYS_DIR`.
- `mcp/` — MCP server (stdio): `search_vendors`, `buy`, `budget_status`.
- `web/` — dashboard: vault, agents, escrows, marketplace, demo scenes.

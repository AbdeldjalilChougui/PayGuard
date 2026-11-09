# Deploy PayGuard on Render (free plan)

PayGuard runs as two Render services from one Blueprint (`render.yaml`):

| Service | Type | What it runs |
|---|---|---|
| `payguard-server` | Web Service (Node, free) | demo vendors, AI agent, faucet, escrow crank |
| `payguard-web` | Static Site (free) | the dashboard |

The Solana program is already on devnet; Render hosts only the off-chain parts.

## Before you start

1. The repo is on GitHub, including `payguard.config.json` and
   `web/src/payguard.config.json` (public keys only, written by `pnpm setup`).
2. Locally, print the demo keys as one value:

   ```bash
   pnpm keys:export > /tmp/payguard-keys.txt
   ```

   These are **devnet demo keys** (agent, vendors, crank, demo owner). Your
   deploy wallet `~/.config/solana/id.json` is never included. Paste the value
   into Render only, then delete the file.

## Steps

1. Render dashboard → **New → Blueprint** → pick the GitHub repo → **Apply**.
2. Fill in the secrets Render asks for:

   | Service | Key | Value |
   |---|---|---|
   | server | `GEMINI_API_KEY` | your Gemini key |
   | server | `SOLANA_RPC_URL` | your Helius devnet URL |
   | server | `PUBLIC_BASE_URL` | `https://payguard-server.onrender.com` (the server's URL; fix it after step 3 if Render adds a suffix) |
   | server | `PAYGUARD_KEYS` | the line from `pnpm keys:export` |
   | web | `VITE_RPC_URL` | your Helius devnet URL (devnet-only key, it ships to the browser) |
   | web | `VITE_API_URL` | same as `PUBLIC_BASE_URL` |

3. Wait for both deploys. Open `https://<server>/health`: it should answer `{"ok":true}`.
4. Point the on-chain vendor listings at the server (they store full URLs):

   ```bash
   PUBLIC_BASE_URL=https://payguard-server.onrender.com pnpm setup
   ```

   Setup is idempotent: it only updates the listing URLs, then commit and push
   the config if it changed.
5. Open the static site and click **Live demo**.

## Free plan behaviour

- The server **sleeps after 15 minutes** without traffic. The first request
  then takes 30–60 seconds. Before a demo, open `/health` and wait for it.
- While it sleeps, the crank does not run. Escrows still settle: anyone can
  call `release` / `refund_expired`, the agent refunds its own expired
  escrows, and the crank catches up when the server wakes.
- Nothing is stored on the server's disk; all state is on devnet.

## After `pnpm demo:reset`

Reset creates a new agent key and updates the config. Run `pnpm keys:export`
again, update `PAYGUARD_KEYS` on Render, then commit and push the config.

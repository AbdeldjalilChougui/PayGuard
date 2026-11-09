// The whole PayGuard backend in one Node service (fits one free Render web
// service): demo vendors, the agent, a devnet faucet and the escrow crank.
import express, { type NextFunction, type Request, type Response } from "express";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { startCrank } from "@payguard/sdk";
import { type RunEvent, runAgent, runAttack } from "./agent.js";
import { BASE_URL, PORT, connection, hasKey, loadConfig, loadKey, ownerKeypair } from "./env.js";
import { vendorRouter } from "./vendors.js";

const cfg = loadConfig();
const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => void res.json({ name: "PayGuard server", vault: cfg.vault, vendors: `${BASE_URL}/v/…` }));
app.get("/health", (_req, res) => void res.json({ ok: true }));

app.use("/v", vendorRouter(cfg));

// ── Agent runs, streamed as NDJSON ──────────────────────────────────────────
// One run at a time (one agent key, one Gemini quota), and an hourly cap so a
// public demo cannot burn the quota or the devnet SOL.
let busy = false;
const RUNS_PER_HOUR = Number(process.env.AGENT_RUNS_PER_HOUR ?? 30);
let window = { start: Date.now(), count: 0 };

async function stream(res: Response, job: (emit: (e: RunEvent) => void) => Promise<void>) {
  if (busy) return void res.status(409).json({ error: "The agent is busy with another run. Try again in a minute." });
  if (Date.now() - window.start > 3_600_000) window = { start: Date.now(), count: 0 };
  if (window.count >= RUNS_PER_HOUR) return void res.status(429).json({ error: "Demo run limit reached for this hour." });
  window.count++;
  busy = true;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  try {
    await job((e) => res.write(JSON.stringify(e) + "\n"));
  } catch (e) {
    res.write(JSON.stringify({ type: "error", message: (e as Error).message }) + "\n");
  } finally {
    busy = false;
    res.end();
  }
}

const vaultOf = (req: Request) => String(req.body?.vault ?? cfg.vault);

app.post("/agent/run", async (req, res) => {
  const task = String(req.body?.task ?? "").slice(0, 500);
  if (!task) return void res.status(400).json({ error: "task is required" });
  await stream(res, (emit) => runAgent(task, vaultOf(req), emit));
});

// Stolen-key scene: raw transactions signed with the agent key, no AI.
app.post("/agent/attack", async (req, res) => {
  await stream(res, (emit) => runAttack(vaultOf(req), emit));
});

// ── Devnet faucet ───────────────────────────────────────────────────────────
// Enough for a fresh Phantom wallet to create a vault. Per-wallet cooldown and
// an hourly cap so new wallets cannot drain it.
const faucetUsed = new Map<string, number>();
const FAUCET_PER_HOUR = Number(process.env.FAUCET_PER_HOUR ?? 10);
const FAUCET_SOL = Number(process.env.FAUCET_SOL ?? 0.03);
const FAUCET_TOKENS = 50;
let faucetWindow = { start: Date.now(), count: 0 };

app.post("/faucet", async (req, res) => {
  try {
    const wallet = new PublicKey(String(req.body?.wallet));
    const last = faucetUsed.get(wallet.toBase58()) ?? 0;
    if (Date.now() - last < 10 * 60_000) return void res.status(429).json({ error: "Try again in a few minutes." });
    if (Date.now() - faucetWindow.start > 3_600_000) faucetWindow = { start: Date.now(), count: 0 };
    if (faucetWindow.count >= FAUCET_PER_HOUR) return void res.status(429).json({ error: "Faucet is busy, try again later." });
    faucetWindow.count++;
    faucetUsed.set(wallet.toBase58(), Date.now());

    const owner = ownerKeypair();
    const mint = new PublicKey(cfg.mint);
    if ((await connection.getBalance(wallet)) < FAUCET_SOL * LAMPORTS_PER_SOL) {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wallet, lamports: Math.round(FAUCET_SOL * LAMPORTS_PER_SOL) }),
      );
      await sendAndConfirmTransaction(connection, tx, [owner]);
    }
    const ata = await getOrCreateAssociatedTokenAccount(connection, owner, mint, wallet);
    await mintTo(connection, owner, mint, ata.address, owner, FAUCET_TOKENS * 10 ** cfg.decimals);
    res.json({ ok: true, sol: FAUCET_SOL, tokens: FAUCET_TOKENS });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(502).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`PayGuard server on ${BASE_URL} (port ${PORT})`);
  // Settles escrows nobody touched: pays vendors after the dispute window,
  // refunds vaults after a missed receipt deadline.
  if (hasKey("crank")) startCrank(connection, loadKey("crank"), 10_000, (m) => console.log(m));
});

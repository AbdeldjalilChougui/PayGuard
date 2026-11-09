// End-to-end on devnet, no LLM: every scene through the real server, vendors,
// escrow and crank. Needs `pnpm server` running. Uses its own agent key so the
// demo agent's budget stays full.
//   pnpm e2e            (server at http://localhost:4000)
//   E2E_BASE=https://… pnpm e2e
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { BN, PayGuardAgent, encodeHeader, send, fetchVendor, fromHex, type PaymentRequired, type Purchase } from "@payguard/sdk";
import { VENDORS } from "../server/catalog.js";
import { connection, loadConfig } from "../server/env.js";
import { addDemoAgent, fund, keypair } from "./setup.js";

const cfg = loadConfig();
const BASE = (process.env.E2E_BASE ?? "http://localhost:4000").replace(/\/$/, "");
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`);
    process.exit(1);
  }
}

function expectOutcome(p: Purchase | undefined, outcome: Purchase["outcome"], code?: string) {
  assert.ok(p, "no payment happened");
  assert.equal(p.outcome, outcome, `expected ${outcome}${code ? ` (${code})` : ""}, got ${p.outcome} ${p.code ?? ""} ${p.reason ?? ""}`);
  if (code) assert.equal(p.code, code);
}

async function main() {
  const owner = keypair("owner");
  const key = keypair("e2e-agent");
  await fund(owner, key.publicKey, 0.03);
  const vault = new PublicKey(cfg.vault);
  const vendorPdas = Object.fromEntries(VENDORS.map((v) => [v.key, new PublicKey(cfg.vendors[v.key].pda)]));
  await addDemoAgent(owner, vault, key.publicKey, vendorPdas);
  const agent = new PayGuardAgent({ connection, agent: key, vault, decimals: cfg.decimals, responseTimeoutMs: 10_000 });
  const before = await agent.budget();
  console.log(`e2e agent ${key.publicKey.toBase58()} · ${BASE} · spent today ${before.spentToday}/${before.dailyLimit}`);
  const url = (p: string) => `${BASE}${p}`;

  await check("marketplace lists vendors with reputation", async () => {
    const rows = await agent.searchVendors();
    assert.ok(rows.length >= VENDORS.length, `only ${rows.length} vendors`);
    assert.equal(rows.find((r) => r.name === "CoinDatas Pro")?.approved, false);
    assert.equal(rows.find((r) => r.name === "CoinData Pro")?.approved, true);
  });

  await check("honest vendor: escrow, receipt, accept, real data", async () => {
    const pda = new PublicKey(cfg.vendors.prices.pda);
    const delivered = (await fetchVendor(agent.program, pda))!.delivered.toNumber();
    const r = await agent.fetch(url("/v/prices?ids=solana"));
    expectOutcome(r.payment, "accepted");
    assert.ok(JSON.parse(r.body).prices.solana.usd > 0, "no SOL price in the body");
    assert.equal((await fetchVendor(agent.program, pda))!.delivered.toNumber(), delivered + 1);
  });

  await check("lookalike vendor is blocked by the allowlist", async () => {
    expectOutcome((await agent.fetch(url("/v/prices-discount?ids=solana"))).payment, "blocked", "VendorNotAllowed");
  });

  await check("invoice above the listed price is blocked", async () => {
    expectOutcome((await agent.fetch(url("/v/prices/realtime?ids=solana"))).payment, "blocked", "OverListedPrice");
  });

  await check("billing loop stops at the vendor's daily budget", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = (await agent.fetch(url("/v/ticker?ids=solana"))).payment!;
      outcomes.push(p.code ?? p.outcome);
      if (p.outcome !== "accepted") break;
    }
    assert.deepEqual(outcomes.slice(-1), ["OverVendorBudget"], `got ${outcomes.join(", ")}`);
  });

  await check("junk delivery is disputed and refunded", async () => {
    const r = await agent.fetch(url("/v/digest?topic=crypto"));
    expectOutcome(r.payment, "disputed", "Disputed");
  });

  await check("replayed payment proof is refused", async () => {
    const inv = (await (await fetch(url("/v/fx?base=USD&to=EUR"))).json()) as PaymentRequired;
    const req = inv.accepts[0];
    const opened = await agent.openEscrow(new PublicKey(req.payTo), new BN(req.maxAmountRequired), fromHex(req.extra.nonce));
    assert.ok(opened.ok, `escrow failed: ${!opened.ok && opened.code}`);
    const header = encodeHeader({ x402Version: 1, scheme: req.scheme, network: req.network, payload: { escrow: opened.escrow.toBase58(), signature: opened.signature, nonce: req.extra.nonce } });
    const first = await fetch(url("/v/fx?base=USD&to=EUR"), { headers: { "X-PAYMENT": header } });
    assert.equal(first.status, 200);
    const again = await fetch(url("/v/fx?base=USD&to=EUR"), { headers: { "X-PAYMENT": header } });
    assert.equal(again.status, 402, "replay was served");
    // The escrow stays Delivered; the crank releases it after the dispute window.
  });

  await check("agent key cannot change its own limits", async () => {
    const ix = await agent.program.methods
      .updateAgent(new BN(1e12), new BN(1e12), [])
      .accountsPartial({ owner: key.publicKey, vault, agentPolicy: agent.agentPolicy })
      .instruction();
    const r = await send(connection, [ix], key, { audit: true });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "ConstraintHasOne");
  });

  await check("ghost vendor: no receipt, money comes back after the deadline", async () => {
    expectOutcome((await agent.fetch(url("/v/quote?ids=solana"))).payment, "refunded", "NoDelivery");
  });

  const after = await agent.budget();
  console.log(`\n${passed} checks passed · spent today ${after.spentToday} (refunds credited back)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

// A deliberately ordinary autonomous agent: it shops the marketplace, pays what
// vendors ask and trusts tool output. PayGuard is what keeps its wallet safe.
import { PublicKey } from "@solana/web3.js";
import {
  PayGuardAgent,
  explorerTx,
  fetchVault,
  fromUnits,
  send,
  toUnits,
  vaultTokenOf,
  type Purchase,
} from "@payguard/sdk";
import { VENDORS } from "./catalog.js";
import { connection, loadConfig, loadKey } from "./env.js";

export type RunEvent =
  | { type: "start"; task: string; vault: string; model: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "invoice"; vendorName: string; amount: number }
  | { type: "escrow"; vendorName: string; amount: number; escrow: string; explorer?: string }
  | { type: "waiting"; message: string }
  | ({ type: "payment"; explorer?: string } & Purchase)
  | { type: "answer"; text: string }
  | { type: "error"; message: string };
export type Emit = (e: RunEvent) => void;

// Free-tier quotas are per model and per day, so a rate-limited model hands
// over to the next one instead of killing the demo.
const MODELS = (process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
let modelIdx = 0;
// Gemini Interactions API (new projects can no longer use generateContent).
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const THINKING = process.env.GEMINI_THINKING ?? "minimal";
const MAX_TURNS = 10;
// A naive x402 client: it keeps paying a stream while it says there is more.
const MAX_PAYMENTS_PER_CALL = 12;

function makeAgent(vault: PublicKey, emit: Emit) {
  const cfg = loadConfig(); // re-read so `pnpm demo:reset` needs no restart
  const agent = new PayGuardAgent({
    connection,
    agent: loadKey("agent"),
    vault,
    decimals: cfg.decimals,
    responseTimeoutMs: 12_000,
    onEvent: (e) => {
      if (e.type === "invoice") emit({ type: "invoice", vendorName: e.vendorName, amount: e.amount });
      if (e.type === "escrow")
        emit({
          type: "escrow",
          vendorName: e.purchase.vendorName,
          amount: e.purchase.amount,
          escrow: e.purchase.escrow!,
          explorer: e.purchase.signatures[0] ? explorerTx(e.purchase.signatures[0]) : undefined,
        });
      if (e.type === "waiting") emit({ type: "waiting", message: e.message });
      if (e.type === "settled") {
        const last = e.purchase.signatures.at(-1);
        emit({ type: "payment", ...e.purchase, explorer: last ? explorerTx(last) : undefined });
      }
    },
  });
  return { cfg, agent };
}

const system = (symbol: string) => `You are an autonomous research assistant with a wallet holding ${symbol} (a dollar stablecoin).
Complete the user's task end-to-end without asking for confirmation.
Find paid APIs with search_vendors, then call a vendor's url with http_get (adjust the query parameters as its description says).
Payments are automatic: http_get pays the vendor's invoice from your wallet.
Prefer the cheapest vendor that has the data.
If a purchase is blocked or refunded, try another suitable vendor once, then answer with what you have.
When done, answer concisely in plain text and list what you paid and any refunds.`;

const TOOLS = [
  {
    type: "function",
    name: "search_vendors",
    description: "Search the paid API marketplace. Returns vendors with url, price per call and reputation.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Topic, e.g. 'crypto prices'" } } },
  },
  {
    type: "function",
    name: "http_get",
    description: "GET a vendor URL. If the vendor asks for payment (HTTP 402), pay it from your wallet and retry.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    type: "function",
    name: "budget_status",
    description: "Your spending limits and what is left today.",
    parameters: { type: "object", properties: {} },
  },
];

const summary = (p?: Purchase) =>
  p && { vendor: p.vendorName, amount: p.amount, outcome: p.outcome, ...(p.code ? { code: p.code, reason: p.reason } : {}) };

export async function runAgent(task: string, vaultAddr: string, emit: Emit) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing: set it in server/.env or the Render environment");
  const vault = new PublicKey(vaultAddr);
  const { cfg, agent } = makeAgent(vault, emit);
  const about = new Map(VENDORS.map((v) => [cfg.vendors[v.key]?.pda, v.about]));
  emit({ type: "start", task, vault: vaultAddr, model: MODELS[modelIdx] });

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    emit({ type: "tool", name, args });
    if (name === "search_vendors") {
      // The agent sees what any marketplace shows. Approvals are the owner's
      // business and live on-chain; the agent is not told.
      const rows = await agent.searchVendors();
      const q = String(args.query ?? "").toLowerCase();
      const words = q.split(/\W+/).filter((w) => w.length > 2);
      return rows
        .filter((r) => r.vendor !== cfg.vendors.attacker?.pda)
        .map((r) => ({
          name: r.name,
          url: r.url,
          price: r.price,
          description: about.get(r.vendor) ?? "",
          reputation: r.reputation === null ? "new vendor" : `${Math.round(r.reputation * 100)}% delivered`,
          sales: r.sales,
        }))
        .filter((r) => !words.length || words.some((w) => `${r.name} ${r.description}`.toLowerCase().includes(w)));
    }
    if (name === "budget_status") return agent.budget();
    if (name === "http_get") {
      const url = String(args.url);
      const payments = [];
      let last: { status: number; body: string } = { status: 0, body: "" };
      for (let n = 0; n < MAX_PAYMENTS_PER_CALL; n++) {
        const r = await agent.fetch(url);
        last = r;
        if (r.payment) payments.push(summary(r.payment));
        if (r.payment && r.payment.outcome !== "accepted") break;
        let more = false;
        try {
          more = JSON.parse(r.body)?.more === true;
        } catch {
          // not JSON
        }
        if (!more) break;
      }
      let data: unknown = last.body.slice(0, 2000);
      try {
        data = JSON.parse(last.body);
      } catch {
        // keep text
      }
      return { status: last.status, payments, data };
    }
    return { error: `unknown tool ${name}` };
  }

  type Step = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; content?: { type: string; text?: string }[] };
  async function interact(request: object): Promise<{ id: string; steps?: Step[] }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(GEMINI_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key! },
          body: JSON.stringify({ model: MODELS[modelIdx], ...request }),
          signal: AbortSignal.timeout(120_000),
        });
        const json = await res.json();
        if (res.status === 429 && modelIdx < MODELS.length - 1) {
          modelIdx++;
          attempt--;
          continue;
        }
        if (!res.ok) throw new Error(json.error?.message ?? `Gemini returned ${res.status}`);
        return json;
      } catch (e) {
        if (attempt >= 1 || /model|key|quota|credits/i.test((e as Error).message)) throw e;
      }
    }
  }

  let input: unknown = task;
  let previous: string | undefined;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await interact({
      system_instruction: system(cfg.symbol),
      tools: TOOLS,
      generation_config: { thinking_level: THINKING },
      input,
      ...(previous ? { previous_interaction_id: previous } : {}),
    });
    previous = r.id;
    const steps = r.steps ?? [];
    const calls = steps.filter((s) => s.type === "function_call");
    if (calls.length === 0) {
      const text = steps
        .filter((s) => s.type === "model_output")
        .flatMap((s) => s.content ?? [])
        .map((c) => c.text ?? "")
        .join("");
      emit({ type: "answer", text });
      return;
    }
    const results = [];
    for (const call of calls) {
      let result: unknown;
      try {
        result = await callTool(call.name!, call.arguments ?? {});
      } catch (e) {
        result = { error: (e as Error).message };
      }
      results.push({ type: "function_result", call_id: call.id, name: call.name, result: JSON.stringify(result) });
    }
    input = results;
  }
  emit({ type: "answer", text: "Stopped: too many steps." });
}

/**
 * Stolen-key scene, no AI: an attacker holding the agent's key tries to drain
 * the vault. The worst they can do is bounded by the owner's rules.
 */
export async function runAttack(vaultAddr: string, emit: Emit) {
  const vault = new PublicKey(vaultAddr);
  const { cfg, agent } = makeAgent(vault, emit);
  emit({ type: "start", task: "Attacker with the stolen agent key tries to drain the vault", vault: vaultAddr, model: "no AI: raw transactions" });

  const v = await fetchVault(agent.program, vault);
  if (!v) throw new Error("vault not found");
  const balance = (await connection.getTokenAccountBalance(vaultTokenOf(vault, v.mint))).value.uiAmount ?? 0;
  const amount = toUnits(Math.max(balance - fromUnits(v.locked, cfg.decimals), 0.01), cfg.decimals);
  const nonce = () => crypto.getRandomValues(new Uint8Array(16));
  const results: string[] = [];

  const report = (vendorName: string, amt: number, r: { ok: boolean; signature?: string; code?: string; message?: string }, reason: string) => {
    if (!r.ok) results.push(r.code ?? "Failed");
    emit({
      type: "payment",
      vendor: "",
      vendorName,
      amount: amt,
      outcome: r.ok ? "accepted" : "blocked",
      code: r.code,
      reason: r.ok ? reason : r.message,
      signatures: r.signature ? [r.signature] : [],
      explorer: r.signature ? explorerTx(r.signature) : undefined,
    });
  };

  // 1. Pay the whole vault to the attacker's own listing.
  emit({ type: "tool", name: "steal", args: { to: cfg.vendors.attacker.name, amount: fromUnits(amount, cfg.decimals), how: "escrow to own vendor" } });
  report(cfg.vendors.attacker.name, fromUnits(amount, cfg.decimals), await agent.openEscrow(new PublicKey(cfg.vendors.attacker.pda), amount, nonce()), "drain to own vendor");

  // 2. Push the whole vault through an approved vendor.
  emit({ type: "tool", name: "steal", args: { to: cfg.vendors.ticker.name, amount: fromUnits(amount, cfg.decimals), how: "escrow to approved vendor" } });
  report(cfg.vendors.ticker.name, fromUnits(amount, cfg.decimals), await agent.openEscrow(new PublicKey(cfg.vendors.ticker.pda), amount, nonce()), "launder via approved vendor");

  // 3. Rewrite the agent's own limits.
  emit({ type: "tool", name: "steal", args: { how: "raise own daily limit to 1,000,000" } });
  const ix = await agent.program.methods
    .updateAgent(toUnits(1_000_000, cfg.decimals), toUnits(1_000_000, cfg.decimals), [])
    .accountsPartial({ owner: loadKey("agent").publicKey, vault, agentPolicy: agent.agentPolicy })
    .instruction();
  report("own limits", 1_000_000, await send(connection, [ix], loadKey("agent"), { audit: true }), "raise limits");

  const paused = results.includes("VaultPaused");
  emit({
    type: "answer",
    text:
      `${results.length}/3 theft attempts blocked on-chain. ` +
      (paused
        ? "The owner paused the vault, so nothing can move, whoever holds the key."
        : `With the agent's key, an attacker can only open escrows at listed prices, to approved vendors, within the daily budgets, and the vendor is paid only if it delivers. Only the owner can change the rules or press Pause.`),
  });
}


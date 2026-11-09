// Agent side: pay x402 invoices through a PayGuard vault, check what the
// vendor delivered, then accept, dispute or wait for the refund.
import { BN } from "./bn.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  agentPda,
  allVendors,
  escrowPda,
  fetchAgent,
  fetchEscrow,
  fetchVault,
  fetchVendor,
  fromHex,
  fromUnits,
  getProgram,
  isDelivered,
  reputation,
  sha256,
  toHex,
  vaultTokenOf,
  type EscrowState,
  type PayGuardProgram,
  type VendorState,
} from "./program.js";
import { send, type TxResult } from "./tx.js";
import { SCHEME, decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired, type PaymentResponse } from "./x402.js";

export type Outcome = "accepted" | "disputed" | "refunded" | "blocked" | "failed";

export type Purchase = {
  vendor: string;
  vendorName: string;
  amount: number;
  outcome: Outcome;
  escrow?: string;
  code?: string;
  reason?: string;
  signatures: string[];
};

export type GuardedResponse = { status: number; body: string; payment?: Purchase };

export type AgentEvent =
  | { type: "invoice"; url: string; vendorName: string; amount: number }
  | { type: "escrow"; purchase: Purchase }
  | { type: "settled"; purchase: Purchase }
  | { type: "waiting"; message: string };

/** Returns true when the response is acceptable, or a reason string when not. */
export type Validator = (body: string, contentType: string) => true | string;

/** Default check: a JSON object that is not an error. */
export const jsonValidator: Validator = (body, contentType) => {
  if (!contentType.includes("json")) return `expected JSON, got ${contentType || "no content type"}`;
  try {
    const v = JSON.parse(body);
    if (!v || typeof v !== "object") return "empty response";
    if ("error" in v) return `vendor error: ${String(v.error)}`;
    return true;
  } catch {
    return "response is not valid JSON";
  }
};

export type AgentOptions = {
  connection: Connection;
  agent: Keypair;
  vault: PublicKey;
  decimals: number;
  validate?: Validator;
  /** How long to wait for the vendor after paying. */
  responseTimeoutMs?: number;
  onEvent?: (e: AgentEvent) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PayGuardAgent {
  readonly program: PayGuardProgram;
  readonly agentPolicy: PublicKey;
  private vendorCache = new Map<string, VendorState>();
  private opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.program = getProgram(opts.connection);
    this.agentPolicy = agentPda(opts.vault, opts.agent.publicKey);
  }

  get connection() {
    return this.opts.connection;
  }

  private emit(e: AgentEvent) {
    this.opts.onEvent?.(e);
  }

  private async vendor(pda: PublicKey) {
    const key = pda.toBase58();
    const cached = this.vendorCache.get(key);
    if (cached) return cached;
    const v = await fetchVendor(this.program, pda);
    if (v) this.vendorCache.set(key, v);
    return v;
  }

  /** Marketplace listing with on-chain reputation and whether this agent may buy. */
  async searchVendors(query = "") {
    const [rows, policy] = await Promise.all([allVendors(this.program), fetchAgent(this.program, this.agentPolicy)]);
    const approved = new Set(policy?.rules.map((r) => r.vendor.toBase58()) ?? []);
    const q = query.toLowerCase();
    return rows
      .filter((r) => r.account.active)
      .filter((r) => !q || `${r.account.name} ${r.account.url}`.toLowerCase().includes(q))
      .map((r) => ({
        vendor: r.publicKey.toBase58(),
        name: r.account.name,
        url: r.account.url,
        price: fromUnits(r.account.price, this.opts.decimals),
        sales: r.account.sales.toNumber(),
        reputation: reputation(r.account),
        approved: approved.has(r.publicKey.toBase58()),
      }));
  }

  async budget() {
    const [policy, vault] = await Promise.all([fetchAgent(this.program, this.agentPolicy), fetchVault(this.program, this.opts.vault)]);
    if (!policy || !vault) throw new Error("agent policy or vault not found");
    const bal = await this.connection.getTokenAccountBalance(vault.tokenAccount);
    const d = this.opts.decimals;
    return {
      paused: policy.paused || vault.paused,
      perPaymentCap: fromUnits(policy.perTxCap, d),
      dailyLimit: fromUnits(policy.dailyLimit, d),
      spentToday: fromUnits(policy.spentToday, d),
      leftToday: fromUnits(policy.dailyLimit.sub(policy.spentToday), d),
      vaultFree: Number(bal.value.uiAmount ?? 0) - fromUnits(vault.locked, d),
      vendorBudgets: await Promise.all(
        policy.rules.map(async (r) => ({
          vendor: (await this.vendor(r.vendor))?.name ?? r.vendor.toBase58(),
          dailyCap: r.dailyCap.isZero() ? null : fromUnits(r.dailyCap, d),
          spentToday: fromUnits(r.spentToday, d),
        })),
      ),
    };
  }

  /** Locks `amount` (base units) for a vendor. Failed attempts land on-chain. */
  async openEscrow(vendor: PublicKey, amount: BN, nonce: Uint8Array): Promise<TxResult & { escrow: PublicKey }> {
    const vault = await fetchVault(this.program, this.opts.vault);
    if (!vault) throw new Error("vault not found");
    const escrow = escrowPda(this.agentPolicy, nonce);
    const ix = await this.program.methods
      .openEscrow(amount, Array.from(nonce))
      .accountsPartial({
        agent: this.opts.agent.publicKey,
        vault: this.opts.vault,
        vaultToken: vault.tokenAccount,
        agentPolicy: this.agentPolicy,
        vendor,
        escrow,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return { ...(await send(this.connection, [ix], this.opts.agent, { audit: true })), escrow };
  }

  async accept(escrow: PublicKey, e: EscrowState) {
    const vendor = await this.vendor(e.vendor);
    const vault = await fetchVault(this.program, e.vault);
    if (!vendor || !vault) throw new Error("vendor or vault not found");
    const vendorToken = getAssociatedTokenAddressSync(vault.mint, vendor.payTo, true);
    const ix = await this.program.methods
      .accept()
      .accountsPartial({
        agent: this.opts.agent.publicKey,
        agentPolicy: this.agentPolicy,
        escrow,
        payer: e.payer,
        vault: e.vault,
        vaultToken: vaultTokenOf(e.vault, vault.mint),
        mint: vault.mint,
        vendor: e.vendor,
        vendorToken,
      })
      .instruction();
    const ata = createAssociatedTokenAccountIdempotentInstruction(this.opts.agent.publicKey, vendorToken, vendor.payTo, vault.mint);
    return send(this.connection, [ata, ix], this.opts.agent);
  }

  async dispute(escrow: PublicKey, e: EscrowState) {
    const ix = await this.program.methods
      .dispute()
      .accountsPartial({
        agent: this.opts.agent.publicKey,
        agentPolicy: this.agentPolicy,
        escrow,
        payer: e.payer,
        vault: e.vault,
        vendor: e.vendor,
      })
      .instruction();
    return send(this.connection, [ix], this.opts.agent);
  }

  async refundExpired(escrow: PublicKey, e: EscrowState) {
    const ix = await this.program.methods
      .refundExpired()
      .accountsPartial({ escrow, payer: e.payer, agentPolicy: e.agentPolicy, vault: e.vault, vendor: e.vendor })
      .instruction();
    return send(this.connection, [ix], this.opts.agent);
  }

  /** Waits for the receipt deadline, then claims the refund (unless a crank already did). */
  private async refundWhenExpired(escrow: PublicKey): Promise<TxResult | null> {
    for (;;) {
      const e = await fetchEscrow(this.program, escrow);
      if (!e) return null; // already settled by the crank
      if (isDelivered(e)) return null;
      const wait = e.deadline.toNumber() * 1000 - Date.now() + 3000;
      if (wait <= 0) return this.refundExpired(escrow, e);
      this.emit({ type: "waiting", message: `vendor did not answer; refund possible in ${Math.ceil(wait / 1000)}s` });
      await sleep(Math.min(wait, 5000));
    }
  }

  private async escrowWithRetry(escrow: PublicKey, until: (e: EscrowState) => boolean) {
    for (let i = 0; i < 8; i++) {
      const e = await fetchEscrow(this.program, escrow);
      if (e && until(e)) return e;
      await sleep(700);
    }
    return fetchEscrow(this.program, escrow);
  }

  /**
   * fetch() that pays 402 invoices through PayGuard. At most one payment per
   * call; the result says what happened to the money.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<GuardedResponse> {
    const first = await fetch(url, init);
    if (first.status !== 402) return { status: first.status, body: await first.text() };

    const required = (await first.json().catch(() => null)) as PaymentRequired | null;
    const req = required?.accepts?.find((a) => a.scheme === SCHEME);
    if (!req) return { status: 402, body: JSON.stringify(required) };

    const vendorPk = new PublicKey(req.payTo);
    const amount = new BN(req.maxAmountRequired);
    const nonce = fromHex(req.extra.nonce);
    const purchase: Purchase = {
      vendor: req.payTo,
      vendorName: req.extra.vendorName,
      amount: fromUnits(amount, this.opts.decimals),
      outcome: "failed",
      signatures: [],
    };
    this.emit({ type: "invoice", url, vendorName: purchase.vendorName, amount: purchase.amount });

    const opened = await this.openEscrow(vendorPk, amount, nonce);
    if (opened.signature) purchase.signatures.push(opened.signature);
    if (!opened.ok) {
      Object.assign(purchase, { outcome: "blocked", code: opened.code, reason: opened.message });
      this.emit({ type: "settled", purchase });
      return { status: 402, body: "", payment: purchase };
    }
    purchase.escrow = opened.escrow.toBase58();
    this.emit({ type: "escrow", purchase });

    const header: PaymentPayload = {
      x402Version: 1,
      scheme: SCHEME,
      network: req.network,
      payload: { escrow: opened.escrow.toBase58(), signature: opened.signature, nonce: toHex(nonce) },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.responseTimeoutMs ?? 15_000);
    let res: Response | null = null;
    let body = "";
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal, headers: { ...(init.headers ?? {}), "X-PAYMENT": encodeHeader(header) } });
      body = await res.text();
    } catch {
      res = null;
    } finally {
      clearTimeout(timer);
    }

    // No delivery: the money is only locked, so wait out the deadline and take it back.
    if (!res || !res.ok) {
      const refund = await this.refundWhenExpired(opened.escrow);
      if (refund?.signature) purchase.signatures.push(refund.signature);
      Object.assign(purchase, {
        outcome: "refunded",
        code: "NoDelivery",
        reason: res ? `vendor answered HTTP ${res.status}` : "vendor did not answer in time",
      });
      this.emit({ type: "settled", purchase });
      return { status: res?.status ?? 504, body, payment: purchase };
    }

    const receipt = decodeHeader<PaymentResponse>(res.headers.get("x-payment-response"));
    const e = await this.escrowWithRetry(opened.escrow, isDelivered);
    const hash = toHex(await sha256(body));
    let verdict: true | string = true;
    if (!e || !isDelivered(e)) verdict = "vendor posted no receipt";
    else if (toHex(e.receiptHash) !== hash) verdict = "response does not match the on-chain receipt";
    else verdict = (this.opts.validate ?? jsonValidator)(body, res.headers.get("content-type") ?? "");
    if (receipt?.receipt) purchase.signatures.push(receipt.receipt);

    if (verdict === true && e) {
      const r = await this.accept(opened.escrow, e);
      if (r.signature) purchase.signatures.push(r.signature);
      purchase.outcome = r.ok ? "accepted" : "failed";
      if (!r.ok) Object.assign(purchase, { code: r.code, reason: r.message });
    } else if (e && isDelivered(e)) {
      const r = await this.dispute(opened.escrow, e);
      if (r.signature) purchase.signatures.push(r.signature);
      Object.assign(purchase, { outcome: r.ok ? "disputed" : "failed", code: r.ok ? "Disputed" : r.code, reason: verdict });
    } else {
      const refund = await this.refundWhenExpired(opened.escrow);
      if (refund?.signature) purchase.signatures.push(refund.signature);
      Object.assign(purchase, { outcome: "refunded", code: "NoReceipt", reason: verdict });
    }
    this.emit({ type: "settled", purchase });
    return { status: res.status, body, payment: purchase };
  }
}

// Web-side helpers on top of @payguard/sdk: config, formatting, activity feed.
import { BorshInstructionCoder, EventParser } from "@anchor-lang/core";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { PROGRAM_ID, RULE_TEXT, fromUnits as fromBase, parseError, type PayGuardProgram } from "@payguard/sdk";
import cfg from "../payguard.config.json";

export const config = cfg;
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";
export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const MINT = new PublicKey(cfg.mint);
export const DECIMALS = cfg.decimals;
export const SYMBOL = cfg.symbol;
export const DEMO_VAULT = new PublicKey(cfg.vault);

export const fromUnits = (v: { toString(): string } | number) => fromBase(v, DECIMALS);
export const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
export const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
export { RULE_TEXT };

/** Vendor names from the demo config; the marketplace fills in the rest. */
const names = new Map<string, string>(Object.values(cfg.vendors).map((v) => [v.pda, v.name]));
export const rememberVendor = (pda: string, name: string) => names.set(pda, name);
export const vendorName = (pda: string) => names.get(pda) ?? short(pda);

export type Activity = {
  signature: string;
  time: number | null;
  kind: "escrow" | "receipt" | "paid" | "refunded" | "blocked" | "owner" | "other";
  title: string;
  amount?: number;
  vendor?: string;
  detail?: string;
};

// IDL names may come back as snake_case or camelCase: compare a flat form.
const flat = (s: string) => s.replace(/_/g, "").toLowerCase();

const OWNER_IX: Record<string, string> = {
  createvault: "Vault created",
  deposit: "Deposit",
  withdraw: "Withdraw",
  setvaultpaused: "Pause switch",
  updatevaulttiming: "Escrow timing updated",
  addagent: "Agent added",
  updateagent: "Agent rules updated",
  setagentpaused: "Agent pause switch",
};

function decode(program: PayGuardProgram, tx: VersionedTransactionResponse, signature: string): Activity[] {
  const time = tx.blockTime ?? null;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys;
  const ix = msg.compiledInstructions.find((i) => keys[i.programIdIndex]?.equals(PROGRAM_ID));
  const raw = ix ? ((program.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data)) as { name: string; data: any } | null) : null;
  const decoded = raw && { name: flat(raw.name), data: raw.data };

  if (tx.meta?.err) {
    const err = parseError(tx.meta.logMessages);
    const code = err?.code ?? "Failed";
    if (decoded?.name === "openescrow" && ix) {
      const vendor = keys[ix.accountKeyIndexes[4]]?.toBase58();
      return [{ signature, time, kind: "blocked", title: "Payment blocked", amount: fromUnits(decoded.data.amount), vendor, detail: RULE_TEXT[code] ?? err?.message ?? code }];
    }
    const what = decoded ? (OWNER_IX[decoded.name] ?? decoded.name) : "Transaction";
    return [{ signature, time, kind: "blocked", title: `${what} rejected`, detail: RULE_TEXT[code] ?? err?.message ?? code }];
  }

  const out: Activity[] = [];
  for (const ev of new EventParser(PROGRAM_ID, program.coder).parseLogs(tx.meta?.logMessages ?? [])) {
    const d = ev.data as any;
    const vendor = d.vendor?.toBase58?.();
    const name = flat(ev.name);
    if (name === "escrowopened") out.push({ signature, time, kind: "escrow", title: "Escrow opened", amount: fromUnits(d.amount), vendor });
    else if (name === "receiptposted") out.push({ signature, time, kind: "receipt", title: "Receipt posted", vendor });
    else if (name === "escrowreleased")
      out.push({ signature, time, kind: "paid", title: "Vendor paid", amount: fromUnits(d.amount), vendor, detail: d.early ? "accepted by the agent" : "released after the dispute window" });
    else if (name === "escrowrefunded")
      out.push({
        signature,
        time,
        kind: "refunded",
        title: "Refunded",
        amount: fromUnits(d.amount),
        vendor,
        detail: Object.keys(d.reason ?? {}).some((k) => flat(k) === "disputed") ? "agent disputed the delivery" : "vendor missed the receipt deadline",
      });
  }
  if (out.length) return out;
  if (decoded && OWNER_IX[decoded.name]) {
    let title = OWNER_IX[decoded.name];
    if (decoded.name === "setvaultpaused" || decoded.name === "setagentpaused")
      title = decoded.data.paused ? `${decoded.name === "setvaultpaused" ? "Vault" : "Agent"} paused` : `${decoded.name === "setvaultpaused" ? "Vault" : "Agent"} resumed`;
    const amount = decoded.name === "deposit" || decoded.name === "withdraw" ? fromUnits(decoded.data.amount) : undefined;
    return [{ signature, time, kind: "owner", title, amount }];
  }
  return [];
}

// Confirmed transactions never change, so each is fetched once; the poll stays
// a single cheap call and under public RPC rate limits.
const cache = new Map<string, Activity[]>();

/** Everything that touched the vault, including rejected attempts (failed txs). */
export async function loadActivity(connection: Connection, program: PayGuardProgram, vault: PublicKey, limit = 30) {
  const sigs = await connection.getSignaturesForAddress(vault, { limit });
  const missing = sigs.map((s) => s.signature).filter((s) => !cache.has(s));
  for (let i = 0; i < missing.length; i += 5) {
    const chunk = missing.slice(i, i + 5);
    const txs = await Promise.all(
      chunk.map((sig) => connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null)),
    );
    txs.forEach((tx, j) => tx && cache.set(chunk[j], decode(program, tx, chunk[j]).reverse()));
  }
  return sigs.flatMap((s) => cache.get(s.signature) ?? []);
}

export function ago(t: number | null) {
  if (!t) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

import { useState } from "react";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { agentPda, explorerTx, reputation, toUnits, vaultPda, vaultTokenOf, type PayGuardProgram } from "@payguard/sdk";
import { useVendors } from "../hooks/useVendors";
import { API_URL, DECIMALS, MINT, SYMBOL, config, fmt, fromUnits } from "../lib/pg";

export type RuleDraft = { vendor: string; dailyCap: string };

const demoRules = (): RuleDraft[] =>
  Object.values(config.vendors)
    .filter((v) => v.approved)
    .map((v) => ({ vendor: v.pda, dailyCap: String((v as { dailyCap?: number }).dailyCap ?? "") }));

export const toRuleArgs = (rules: RuleDraft[]) =>
  rules.map((r) => ({ vendor: new PublicKey(r.vendor), dailyCap: toUnits(Number(r.dailyCap) || 0, DECIMALS) }));

/** Pick approved vendors (max 8) and an optional daily budget for each. */
export function VendorPicker({ program, rules, onChange }: { program: PayGuardProgram; rules: RuleDraft[]; onChange: (r: RuleDraft[]) => void }) {
  const vendors = useVendors(program);
  const on = new Map(rules.map((r) => [r.vendor, r]));
  const toggle = (pda: string) =>
    onChange(on.has(pda) ? rules.filter((r) => r.vendor !== pda) : rules.length >= 8 ? rules : [...rules, { vendor: pda, dailyCap: "" }]);
  return (
    <div className="grid gap-1.5">
      {vendors === null && <div className="text-sm text-slate-500">Loading marketplace…</div>}
      {vendors?.map(({ publicKey, account: v }) => {
        const pda = publicKey.toBase58();
        const rule = on.get(pda);
        const rep = reputation(v);
        return (
          <div key={pda} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm ${rule ? "border-sol-purple/50 bg-sol-purple/10" : "border-white/10 bg-black/20"}`}>
            <input type="checkbox" checked={!!rule} onChange={() => toggle(pda)} className="accent-[#9945ff]" aria-label={`Approve ${v.name}`} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{v.name}</div>
              <div className="text-xs text-slate-500">
                {fmt(fromUnits(v.price))} {SYMBOL}/call · {rep === null ? "new" : `${Math.round(rep * 100)}% delivered`}
              </div>
            </div>
            {rule && (
              <input
                className="input !w-24 !py-1 text-right"
                placeholder="no cap"
                inputMode="decimal"
                value={rule.dailyCap}
                aria-label={`Daily budget for ${v.name}`}
                onChange={(e) => onChange(rules.map((r) => (r.vendor === pda ? { ...r, dailyCap: e.target.value } : r)))}
              />
            )}
          </div>
        );
      })}
      <div className="text-xs text-slate-500">{rules.length}/8 approved. The number is a daily budget for that vendor.</div>
    </div>
  );
}

export async function requestFaucet(wallet: PublicKey) {
  const res = await fetch(`${API_URL}/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: wallet.toBase58() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `faucet returned ${res.status}`);
}

export function CreateVault({ program, onCreated }: { program: PayGuardProgram; onCreated: (vault: PublicKey) => void }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [deposit, setDeposit] = useState("10");
  const [agent, setAgent] = useState(config.agent);
  const [cap, setCap] = useState("0.5");
  const [daily, setDaily] = useState("2");
  const [receipt, setReceipt] = useState("20");
  const [dispute, setDispute] = useState("15");
  const [rules, setRules] = useState<RuleDraft[]>(demoRules);
  const [status, setStatus] = useState<{ kind: "info" | "error"; text: string; link?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!wallet) return null;
  const owner = wallet.publicKey;

  async function faucet() {
    setBusy(true);
    setStatus({ kind: "info", text: "Sending devnet SOL and 50 test dollars…" });
    try {
      await requestFaucet(owner);
      setStatus({ kind: "info", text: `Done: you have test ${SYMBOL} now.` });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setStatus(null);
    try {
      const agentKey = new PublicKey(agent.trim());
      const vault = vaultPda(owner, MINT);
      const vaultToken = vaultTokenOf(vault, MINT);
      const ownerToken = getAssociatedTokenAddressSync(MINT, owner);
      const bal = await connection.getTokenAccountBalance(ownerToken).catch(() => null);
      if (!bal || Number(bal.value.uiAmount) < Number(deposit)) throw new Error(`Not enough ${SYMBOL}: press "Get test funds" first.`);

      // Vault, first deposit and the agent's rules: one transaction, one signature.
      const ixs = [
        await program.methods.createVault(new BN(Number(receipt)), new BN(Number(dispute))).accountsPartial({ owner, mint: MINT, vault, vaultToken }).instruction(),
        await program.methods.deposit(toUnits(Number(deposit), DECIMALS)).accountsPartial({ owner, vault, mint: MINT, vaultToken, ownerToken }).instruction(),
        await program.methods
          .addAgent(toUnits(Number(cap), DECIMALS), toUnits(Number(daily), DECIMALS), toRuleArgs(rules))
          .accountsPartial({ owner, vault, agent: agentKey, agentPolicy: agentPda(vault, agentKey) })
          .instruction(),
      ];
      const sig = await (program.provider as AnchorProvider).sendAndConfirm(new Transaction().add(...ixs));
      setStatus({ kind: "info", text: "Vault created.", link: explorerTx(sig) });
      onCreated(vault);
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="text-lg font-bold">Create your vault</h2>
      <p className="mt-1 text-sm text-slate-400">You stay the owner. Your agent can only spend through escrow, inside these rules.</p>

      <div className="mt-4 flex items-center justify-between rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
        <span>Need devnet SOL and test {SYMBOL}?</span>
        <button className="btn-ghost" disabled={busy} onClick={faucet}>
          Get test funds
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label={`First deposit (${SYMBOL})`} value={deposit} onChange={setDeposit} />
        <Field label={`Per-payment cap (${SYMBOL})`} value={cap} onChange={setCap} />
        <Field label={`Agent daily limit (${SYMBOL})`} value={daily} onChange={setDaily} />
        <Field label="Receipt deadline (s)" value={receipt} onChange={setReceipt} />
        <Field label="Dispute window (s)" value={dispute} onChange={setDispute} />
        <div className="col-span-2">
          <div className="label">Agent key</div>
          <input className="input mt-1 font-mono text-xs" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent public key" />
          <div className="mt-1 text-xs text-slate-500">Defaults to the demo agent, so the scenes work on your vault.</div>
        </div>
      </div>

      <div className="label mt-4">Approved vendors</div>
      <div className="mt-2">
        <VendorPicker program={program} rules={rules} onChange={setRules} />
      </div>

      <button className="btn-primary mt-4 w-full" disabled={busy} onClick={create}>
        {busy ? "Waiting for wallet…" : "Create vault"}
      </button>
      {status && (
        <div className={`mt-3 text-sm ${status.kind === "error" ? "text-rose-300" : "text-sol-green"}`}>
          {status.text}{" "}
          {status.link && (
            <a className="text-sol-purple" href={status.link} target="_blank">
              Explorer ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <div className="label">{label}</div>
      <input className="input mt-1" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

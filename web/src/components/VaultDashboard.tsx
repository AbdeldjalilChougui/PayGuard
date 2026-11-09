import { useCallback, useEffect, useState } from "react";
import { AnchorProvider } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  agentPda,
  explorerAddr,
  fetchVault,
  isDelivered,
  toUnits,
  vaultAgents,
  vaultEscrows,
  type AgentState,
  type EscrowState,
  type PayGuardProgram,
  type Row,
  type VaultState,
} from "@payguard/sdk";
import { useVendors } from "../hooks/useVendors";
import { DECIMALS, SYMBOL, config, fmt, fromUnits, loadActivity, short, vendorName, type Activity } from "../lib/pg";
import { ActivityFeed } from "./ActivityFeed";
import { AgentConsole } from "./AgentConsole";
import { VendorPicker, toRuleArgs, type RuleDraft } from "./CreateVault";

type State = { vault: VaultState; balance: number; agents: Row<AgentState>[]; escrows: Row<EscrowState>[] };

export function VaultDashboard({ vault, program }: { vault: PublicKey; program: PayGuardProgram }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  useVendors(program); // fills vendor names
  const [state, setState] = useState<State | null | undefined>(undefined);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const refresh = useCallback(async () => {
    const v = await fetchVault(program, vault).catch(() => null);
    if (!v) return setState(null);
    const [bal, agents, escrows] = await Promise.all([
      connection.getTokenAccountBalance(v.tokenAccount).catch(() => null),
      vaultAgents(program, vault).catch(() => []),
      vaultEscrows(program, vault).catch(() => []),
    ]);
    setState({ vault: v, balance: Number(bal?.value.uiAmount ?? 0), agents, escrows });
    loadActivity(connection, program, vault).then(setActivity).catch(() => {});
  }, [connection, program, vault]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    const c = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [refresh]);

  if (state === undefined) return <div className="card text-slate-400">Loading vault from devnet…</div>;
  if (state === null) return <div className="card">No PayGuard vault at <span className="font-mono">{vault.toBase58()}</span> on devnet.</div>;

  const { vault: v, balance, agents, escrows } = state;
  const locked = fromUnits(v.locked);
  const isOwner = wallet?.publicKey.equals(v.owner) ?? false;
  const hasDemoAgent = agents.some((a) => a.account.agent.toBase58() === config.agent);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="label">Vault</div>
          <a className="font-mono text-sm text-slate-300 hover:text-sol-green" href={explorerAddr(vault.toBase58())} target="_blank">
            {vault.toBase58()} ↗
          </a>
          <div className="text-xs text-slate-500">
            owner {short(v.owner.toBase58())} {isOwner && "(you)"} · receipt deadline {v.receiptTimeout.toString()}s · dispute window {v.disputeWindow.toString()}s
          </div>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${v.paused ? "bg-rose-500/20 text-rose-300" : "bg-sol-green/15 text-sol-green"}`}>
          {v.paused ? "● Paused" : "● Active"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Balance" value={`${fmt(balance)} ${SYMBOL}`} />
        <Stat label="Locked in escrow" value={`${fmt(locked)} ${SYMBOL}`} hint="promised to vendors until they deliver" />
        <Stat label="Free" value={`${fmt(balance - locked)} ${SYMBOL}`} hint="what the owner can withdraw" />
        <Stat label="Agents" value={String(agents.length)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        <div className="grid content-start gap-5">
          {hasDemoAgent ? (
            <AgentConsole vault={vault.toBase58()} onActivity={refresh} />
          ) : (
            <div className="card text-sm text-slate-400">The demo agent is not on this vault, so the scenes are off. Add agent {short(config.agent)} to try them.</div>
          )}
          <Escrows escrows={escrows} now={now} />
          {agents.map((a) => (
            <AgentCard key={a.publicKey.toBase58()} row={a} isOwner={isOwner} program={program} onDone={refresh} />
          ))}
          {isOwner && <OwnerPanel vault={vault} state={v} free={balance - locked} program={program} onDone={refresh} />}
        </div>
        <ActivityFeed items={activity} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card !p-4">
      <div className="label">{label}</div>
      <div className="mt-1 text-xl font-bold">{value}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function Bar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-white/10">
      <div className={`h-full rounded-full ${pct >= 100 ? "bg-rose-400" : "bg-gradient-to-r from-sol-purple to-sol-green"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Escrows({ escrows, now }: { escrows: Row<EscrowState>[]; now: number }) {
  return (
    <div className="card">
      <h3 className="font-bold">Open escrows</h3>
      <p className="mt-1 text-xs text-slate-400">Money promised to a vendor. It moves only when the vendor delivers; otherwise it comes back.</p>
      <ul className="mt-3 grid gap-2 text-sm">
        {escrows.length === 0 && <li className="text-slate-500">None right now.</li>}
        {escrows.map(({ publicKey, account: e }) => {
          const delivered = isDelivered(e);
          const until = (delivered ? e.disputeEnd : e.deadline).toNumber() - now;
          return (
            <li key={publicKey.toBase58()} className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
              <span>
                {delivered ? "🧾" : "🔒"} {fmt(fromUnits(e.amount))} {SYMBOL} · {vendorName(e.vendor.toBase58())}
              </span>
              <span className="text-xs text-slate-400">
                {delivered
                  ? until > 0 ? `delivered · dispute window ${Math.ceil(until)}s` : "delivered · vendor can be paid"
                  : until > 0 ? `waiting for delivery · ${Math.ceil(until)}s left` : "deadline passed · refundable"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AgentCard({ row, isOwner, program, onDone }: { row: Row<AgentState>; isOwner: boolean; program: PayGuardProgram; onDone: () => void }) {
  const a = row.account;
  const [busy, setBusy] = useState(false);
  const spent = fromUnits(a.spentToday);
  const limit = fromUnits(a.dailyLimit);
  const owner = useAnchorWallet()?.publicKey;

  async function togglePause() {
    if (!owner) return;
    setBusy(true);
    try {
      await program.methods.setAgentPaused(!a.paused).accountsPartial({ owner, vault: a.vault, agentPolicy: row.publicKey }).rpc();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-bold">
            Agent {short(a.agent.toBase58())} {a.agent.toBase58() === config.agent && <span className="text-xs font-normal text-slate-400">(demo agent)</span>}
          </h3>
          <div className="text-xs text-slate-500">
            cap {fmt(fromUnits(a.perTxCap))} per payment · {a.payCount.toString()} escrows · refunded {fmt(fromUnits(a.totalRefunded))} {SYMBOL}
          </div>
        </div>
        {isOwner ? (
          <button className="btn-ghost !py-1 text-xs" disabled={busy} onClick={togglePause}>
            {a.paused ? "Resume agent" : "Pause agent"}
          </button>
        ) : (
          a.paused && <span className="text-xs text-rose-300">paused</span>
        )}
      </div>
      <div className="mt-3 flex justify-between text-sm">
        <span>Spent today</span>
        <span>
          {fmt(spent)} / {fmt(limit)} {SYMBOL}
        </span>
      </div>
      <div className="mt-1">
        <Bar used={spent} total={limit} />
      </div>
      <div className="label mt-4">Approved vendors and daily budgets</div>
      <ul className="mt-2 grid gap-2 text-sm">
        {a.rules.map((r) => {
          const cap = fromUnits(r.dailyCap);
          const used = fromUnits(r.spentToday);
          return (
            <li key={r.vendor.toBase58()}>
              <div className="flex justify-between">
                <span>{vendorName(r.vendor.toBase58())}</span>
                <span className="text-slate-400">
                  {fmt(used)} / {cap ? fmt(cap) : "no cap"}
                </span>
              </div>
              {cap > 0 && <Bar used={used} total={cap} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OwnerPanel({ vault, state, free, program, onDone }: { vault: PublicKey; state: VaultState; free: number; program: PayGuardProgram; onDone: () => void }) {
  const wallet = useAnchorWallet()!;
  const owner = wallet.publicKey;
  const [amount, setAmount] = useState("5");
  const [agent, setAgent] = useState("");
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: `${label}: done.` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const funds = {
    owner,
    vault,
    mint: state.mint,
    vaultToken: state.tokenAccount,
    ownerToken: getAssociatedTokenAddressSync(state.mint, owner),
  };

  return (
    <div className="card">
      <h3 className="font-bold">Owner controls</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={state.paused ? "btn-primary" : "btn !bg-rose-500/90 !text-white hover:!bg-rose-500"}
          disabled={busy}
          onClick={() => act(state.paused ? "Resume" : "Pause", () => program.methods.setVaultPaused(!state.paused).accountsPartial({ owner, vault }).rpc())}
        >
          {state.paused ? "Resume vault" : "⏸ Pause vault (all agents)"}
        </button>
      </div>
      <div className="mt-4 flex gap-2">
        <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`Amount in ${SYMBOL}`} />
        <button className="btn-ghost" disabled={busy} onClick={() => act("Deposit", () => program.methods.deposit(toUnits(Number(amount), DECIMALS)).accountsPartial(funds).rpc())}>
          Deposit
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => act("Withdraw", () => program.methods.withdraw(toUnits(Number(amount), DECIMALS)).accountsPartial(funds).rpc())}>
          Withdraw
        </button>
      </div>
      <div className="mt-1 text-xs text-slate-500">You can withdraw up to {fmt(free)} {SYMBOL}; escrowed money is promised to vendors.</div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">Add an agent</summary>
        <input className="input mt-2 font-mono text-xs" placeholder="Agent public key" value={agent} onChange={(e) => setAgent(e.target.value)} />
        <div className="mt-2">
          <VendorPicker program={program} rules={rules} onChange={setRules} />
        </div>
        <button
          className="btn-primary mt-2"
          disabled={busy || !agent}
          onClick={() =>
            act("Agent added", async () => {
              const key = new PublicKey(agent.trim());
              const ix = await program.methods
                .addAgent(toUnits(0.5, DECIMALS), toUnits(2, DECIMALS), toRuleArgs(rules))
                .accountsPartial({ owner, vault, agent: key, agentPolicy: agentPda(vault, key) })
                .instruction();
              await (program.provider as AnchorProvider).sendAndConfirm(new Transaction().add(ix));
            })
          }
        >
          Add agent (cap 0.50, 2.00/day)
        </button>
      </details>
      {msg && <div className={`mt-3 text-sm ${msg.ok ? "text-sol-green" : "text-rose-300"}`}>{msg.text}</div>}
    </div>
  );
}

import { explorerTx } from "@payguard/sdk";
import { SYMBOL, ago, fmt, vendorName, type Activity } from "../lib/pg";

const STYLE: Record<Activity["kind"], [string, string]> = {
  escrow: ["🔒", "border-sky-400/25 bg-sky-400/5"],
  receipt: ["🧾", "border-white/10 bg-black/20"],
  paid: ["✅", "border-sol-green/25 bg-sol-green/5"],
  refunded: ["↩️", "border-amber-400/30 bg-amber-400/5"],
  blocked: ["⛔", "border-rose-500/40 bg-rose-500/10"],
  owner: ["•", "border-white/10 bg-black/20"],
  other: ["•", "border-white/10 bg-black/20"],
};

export function ActivityFeed({ items }: { items: Activity[] }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">On-chain activity</h3>
        <span className="flex items-center gap-2 text-xs text-slate-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-sol-green" /> live from devnet
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Every step is a Solana transaction: escrows, receipts, payouts, refunds, and blocked attempts, which fail inside the
        program and stay on-chain as proof.
      </p>
      <ul className="mt-4 grid gap-2">
        {items.length === 0 && <li className="text-sm text-slate-500">No activity yet.</li>}
        {items.map((a, i) => {
          const [icon, style] = STYLE[a.kind];
          return (
            <li key={`${a.signature}-${i}`} className={`animate-in rounded-xl border p-3 ${style}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    <span>{icon}</span>
                    <span>{a.title}</span>
                    {a.amount !== undefined && (
                      <span className={a.kind === "blocked" ? "text-rose-300" : "text-slate-100"}>
                        {fmt(a.amount)} {SYMBOL}
                      </span>
                    )}
                    {a.vendor && <span className="font-normal text-slate-400">· {vendorName(a.vendor)}</span>}
                  </div>
                  {a.detail && <div className={`mt-1 text-sm ${a.kind === "blocked" ? "text-rose-300" : "text-slate-400"}`}>{a.kind === "blocked" ? `Rule: ${a.detail}` : a.detail}</div>}
                </div>
                <div className="shrink-0 text-right text-xs text-slate-400">
                  <div>{ago(a.time)}</div>
                  <a href={explorerTx(a.signature)} target="_blank" className="text-sol-purple hover:text-sol-green">
                    Explorer ↗
                  </a>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

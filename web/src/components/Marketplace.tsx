import { useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { explorerAddr, reputation, toUnits, vendorPda, type PayGuardProgram } from "@payguard/sdk";
import { useVendors } from "../hooks/useVendors";
import { DECIMALS, MINT, SYMBOL, fmt, fromUnits } from "../lib/pg";

export function Marketplace({ program }: { program: PayGuardProgram }) {
  const vendors = useVendors(program);
  return (
    <div className="grid gap-5 lg:grid-cols-[2.4fr_1fr]">
      <div className="card overflow-x-auto">
        <h2 className="text-lg font-bold">Marketplace</h2>
        <p className="mt-1 text-sm text-slate-400">
          Paid APIs that agents can buy through PayGuard escrow. Reputation is on-chain: it counts what each vendor delivered,
          what expired and what agents disputed. Anyone can list; each owner decides which vendors their agents may pay.
        </p>
        <table className="mt-4 w-full min-w-[640px] text-left text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
          <thead className="text-xs uppercase tracking-wider text-slate-400">
            <tr>
              <th className="py-2">Vendor</th>
              <th>Price</th>
              <th>Sales</th>
              <th>Delivered</th>
              <th>Refunded</th>
              <th>Disputed</th>
              <th>Reputation</th>
              <th className="text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {vendors === null && (
              <tr>
                <td colSpan={8} className="py-4 text-slate-500">Loading from devnet…</td>
              </tr>
            )}
            {vendors?.map(({ publicKey, account: v }) => {
              const rep = reputation(v);
              return (
                <tr key={publicKey.toBase58()} className="border-t border-white/5">
                  <td className="py-2.5">
                    <a href={explorerAddr(publicKey.toBase58())} target="_blank" className="font-medium hover:text-sol-green">
                      {v.name}
                    </a>
                    <div className="max-w-[11rem] truncate font-mono text-xs text-slate-500">{v.url}</div>
                  </td>
                  <td>{fmt(fromUnits(v.price))}</td>
                  <td>{v.sales.toString()}</td>
                  <td className="text-sol-green">{v.delivered.toString()}</td>
                  <td className="text-amber-300">{v.refunded.toString()}</td>
                  <td className="text-rose-300">{v.disputed.toString()}</td>
                  <td>
                    {rep === null ? (
                      <span className="text-slate-500">new</span>
                    ) : (
                      <span className={rep >= 0.9 ? "text-sol-green" : rep >= 0.5 ? "text-amber-300" : "text-rose-300"}>{Math.round(rep * 100)}%</span>
                    )}
                  </td>
                  <td className="text-right">
                    {fmt(fromUnits(v.revenue))} {SYMBOL}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <RegisterVendor program={program} />
    </div>
  );
}

function RegisterVendor({ program }: { program: PayGuardProgram }) {
  const wallet = useAnchorWallet();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [price, setPrice] = useState("0.05");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function register() {
    if (!wallet) return;
    setBusy(true);
    setMsg(null);
    try {
      const authority = wallet.publicKey;
      await program.methods
        .registerVendor(name.trim(), url.trim(), toUnits(Number(price), DECIMALS), authority)
        .accountsPartial({ authority, mint: MINT, vendor: vendorPda(authority) })
        .rpc();
      setMsg({ ok: true, text: "Listed. Owners can now approve you for their agents." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card h-fit">
      <h3 className="font-bold">List your API</h3>
      <p className="mt-1 text-sm text-slate-400">
        One listing per wallet. Serve it with the SDK's <code className="text-sol-green">paywall()</code>: it answers 402, checks the escrow
        on-chain and posts the receipt. You get paid when the agent accepts or the dispute window closes.
      </p>
      {wallet ? (
        <div className="mt-4 grid gap-3">
          <input className="input" placeholder="Name (max 32)" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input font-mono text-xs" placeholder="https://… (max 96)" maxLength={96} value={url} onChange={(e) => setUrl(e.target.value)} />
          <label className="text-sm">
            <span className="label">Price per call ({SYMBOL})</span>
            <input className="input mt-1" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <button className="btn-primary" disabled={busy || !name.trim()} onClick={register}>
            {busy ? "Waiting for wallet…" : "List vendor"}
          </button>
          {msg && <div className={`text-sm ${msg.ok ? "text-sol-green" : "text-rose-300"}`}>{msg.text}</div>}
        </div>
      ) : (
        <div className="mt-4 text-sm text-slate-500">Connect a wallet to list a vendor.</div>
      )}
    </div>
  );
}

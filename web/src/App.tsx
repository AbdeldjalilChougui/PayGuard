import { useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { getProgram, ownerVaults, type PayGuardProgram } from "@payguard/sdk";
import { CreateVault } from "./components/CreateVault";
import { Marketplace } from "./components/Marketplace";
import { VaultDashboard } from "./components/VaultDashboard";
import { DEMO_VAULT } from "./lib/pg";

type Route = { page: "home" } | { page: "market" } | { page: "vault"; vault: PublicKey };

function readRoute(): Route {
  const q = new URLSearchParams(location.search);
  if (q.get("page") === "market") return { page: "market" };
  try {
    const v = q.get("vault");
    if (v) return { page: "vault", vault: new PublicKey(v) };
  } catch {
    // bad address: fall through to home
  }
  return { page: "home" };
}

export default function App() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const program = useMemo(() => getProgram(connection, wallet), [connection, wallet]);
  const [route, setRoute] = useState<Route>(readRoute);
  const [mine, setMine] = useState<PublicKey[] | null>(null);

  useEffect(() => {
    if (!wallet) return setMine(null);
    ownerVaults(program, wallet.publicKey)
      .then((rows) => setMine(rows.map((r) => r.publicKey)))
      .catch(() => setMine([]));
  }, [program, wallet]);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const go = (r: Route) => {
    const url = new URL(location.href);
    url.search = r.page === "market" ? "?page=market" : r.page === "vault" ? `?vault=${r.vault.toBase58()}` : "";
    history.pushState(null, "", url);
    setRoute(r);
    scrollTo({ top: 0 });
  };

  const tab = (active: boolean) => `rounded-lg px-3 py-1.5 text-sm font-medium transition ${active ? "bg-white/10 text-white" : "text-slate-400 hover:text-white"}`;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <button onClick={() => go({ page: "home" })} className="flex items-center gap-3 text-left">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <div>
            <div className="text-lg font-bold tracking-tight">PayGuard</div>
            <div className="text-xs text-slate-400">Safe shopping for AI agents</div>
          </div>
        </button>
        <nav className="flex items-center gap-1">
          <button className={tab(route.page === "vault" && route.vault.equals(DEMO_VAULT))} onClick={() => go({ page: "vault", vault: DEMO_VAULT })}>
            Live demo
          </button>
          <button className={tab(route.page === "market")} onClick={() => go({ page: "market" })}>
            Marketplace
          </button>
          {mine?.map((v) => (
            <button key={v.toBase58()} className={tab(route.page === "vault" && route.vault.equals(v))} onClick={() => go({ page: "vault", vault: v })}>
              My vault
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300">Devnet</span>
          <WalletMultiButton />
        </div>
      </header>

      {route.page === "market" && <Marketplace program={program} />}
      {route.page === "vault" && <VaultDashboard key={route.vault.toBase58()} vault={route.vault} program={program} />}
      {route.page === "home" && <Home program={program} hasVault={!!mine?.length} walletConnected={!!wallet} go={go} />}
    </div>
  );
}

function Home({ program, hasVault, walletConnected, go }: { program: PayGuardProgram; hasVault: boolean; walletConnected: boolean; go: (r: Route) => void }) {
  const layers = [
    ["Marketplace", "Who can I buy from?", "Vendors list paid APIs on-chain. Reputation counts what they delivered, what expired and what was disputed."],
    ["Firewall", "Am I allowed to spend this?", "The owner's rules: approved vendors, listed price, per-payment cap, daily limit, a budget per vendor, Pause."],
    ["Escrow", "Did I get what I paid for?", "Money is locked, not sent. The vendor commits to its response on-chain; bad or missing delivery is refunded."],
  ];
  return (
    <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
      <section className="py-6">
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
          Let your AI agent shop.
          <br />
          <span className="bg-gradient-to-r from-sol-purple to-sol-green bg-clip-text text-transparent">Get your money back when it's cheated.</span>
        </h1>
        <p className="mt-5 max-w-xl text-slate-300">
          Agents now pay for APIs on their own, per request (x402). PayGuard is one Solana program that lets an agent find a
          vendor, pay it through escrow, and get refunded if the vendor fails, all inside limits its owner sets on-chain. It holds
          even when the agent is fooled or its key is stolen.
        </p>
        <ol className="mt-6 grid gap-3">
          {layers.map(([t, q, d], i) => (
            <li key={t} className="card !p-4">
              <div className="flex items-baseline gap-2">
                <span className="text-sol-green">{i + 1}.</span>
                <span className="font-semibold">{t}</span>
                <span className="text-sm text-slate-400">· {q}</span>
              </div>
              <div className="mt-1 text-sm text-slate-400">{d}</div>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex flex-wrap gap-3">
          <button className="btn-primary" onClick={() => go({ page: "vault", vault: DEMO_VAULT })}>
            Watch the live demo
          </button>
          <button className="btn-ghost" onClick={() => go({ page: "market" })}>
            Browse the marketplace
          </button>
        </div>
      </section>
      <section>
        {!walletConnected ? (
          <div className="card flex h-full flex-col items-center justify-center gap-4 py-12 text-center">
            <div className="text-lg font-semibold">Connect Phantom (devnet) to create your own vault</div>
            <p className="max-w-sm text-sm text-slate-400">You stay the owner. Your agent can only spend through escrow, within your rules.</p>
            <WalletMultiButton />
          </div>
        ) : hasVault ? (
          <div className="card flex h-full flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="text-lg font-semibold">You already have a vault</div>
            <p className="text-sm text-slate-400">Open it from "My vault" in the menu.</p>
          </div>
        ) : (
          <CreateVault program={program} onCreated={(v) => go({ page: "vault", vault: v })} />
        )}
      </section>
    </div>
  );
}

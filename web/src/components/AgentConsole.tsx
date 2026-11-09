import { useRef, useState } from "react";
import { API_URL, SYMBOL, fmt } from "../lib/pg";

type Outcome = "accepted" | "disputed" | "refunded" | "blocked" | "failed";
type RunEvent =
  | { type: "start"; task: string; model: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "invoice"; vendorName: string; amount: number }
  | { type: "escrow"; vendorName: string; amount: number; explorer?: string }
  | { type: "waiting"; message: string }
  | { type: "payment"; vendorName: string; amount: number; outcome: Outcome; code?: string; reason?: string; explorer?: string }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

// Each scene shows one way a vendor or a thief goes after the agent's money,
// and the PayGuard layer that stops it.
type Scene = { title: string; tag: string; rule: string; task?: string; attack?: true };
export const SCENES: Scene[] = [
  {
    title: "Market brief",
    tag: "lookalike vendor",
    rule: "Allowlist",
    task: "Prepare a short market brief on Solana: current SOL price and the latest news.",
  },
  { title: "Realtime price", tag: "overcharge", rule: "Listed price", task: "Get the realtime SOL price from CoinData Pro's realtime endpoint (/v/prices/realtime?ids=solana)." },
  { title: "Live ticker", tag: "billing loop", rule: "Vendor budget", task: "Follow the live SOL price on LiveTicker for a few ticks and tell me the trend." },
  { title: "Instant quote", tag: "vendor never delivers", rule: "Escrow refund", task: "Get an instant SOL quote from QuickQuote." },
  { title: "Daily digest", tag: "junk delivery", rule: "Dispute", task: "Get today's crypto digest from DailyDigest and summarise it." },
  { title: "Stolen key", tag: "no AI: attacker", rule: "Rules · Pause", attack: true },
];

const OUTCOME: Record<Outcome, [string, string, string]> = {
  accepted: ["✅", "text-sol-green", "paid"],
  disputed: ["↩️", "text-amber-300", "disputed, refunded"],
  refunded: ["↩️", "text-amber-300", "refunded"],
  blocked: ["⛔", "text-rose-300", "blocked"],
  failed: ["✖", "text-rose-300", "failed"],
};

export function AgentConsole({ vault, onActivity }: { vault: string; onActivity: () => void }) {
  const [task, setTask] = useState(SCENES[0].task!);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [running, setRunning] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  async function run(t = task, attack = false) {
    if (!attack) setTask(t);
    setEvents([]);
    setRunning(true);
    try {
      const res = await fetch(`${API_URL}/agent/${attack ? "attack" : "run"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: t, vault }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `server returned ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const e = JSON.parse(line) as RunEvent;
          setEvents((prev) => [...prev, e]);
          if (e.type === "payment" || e.type === "escrow") onActivity();
          requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "nearest" }));
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      setEvents((prev) => [
        ...prev,
        {
          type: "error",
          message: msg.includes("fetch") ? `Server not reachable at ${API_URL}. On the free Render plan it may be waking up: try again in a minute.` : msg,
        },
      ]);
    } finally {
      setRunning(false);
      onActivity();
    }
  }

  return (
    <div className="card">
      <h3 className="font-bold">AI agent console</h3>
      <p className="mt-1 text-xs text-slate-400">
        A Gemini research agent that shops the marketplace and pays whatever vendors ask, like most agents do. Each scene is one
        attack on its money.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SCENES.map((p, i) => (
          <button
            key={p.title}
            disabled={running}
            onClick={() => run(p.task ?? "", p.attack)}
            className="rounded-lg border border-white/10 bg-black/20 p-2.5 text-left text-sm transition hover:border-sol-purple/60 disabled:opacity-40"
          >
            <div className="font-medium">
              <span className="text-slate-500">{i + 1}.</span> {p.title}
            </div>
            <div className="text-xs text-amber-300">{p.tag}</div>
            <div className="text-xs text-slate-500">Stopped by: {p.rule}</div>
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input className="input" value={task} onChange={(e) => setTask(e.target.value)} disabled={running} aria-label="Task for the agent" />
        <button className="btn-primary shrink-0" disabled={running || !task.trim()} onClick={() => run()}>
          {running ? "Running…" : "Run"}
        </button>
      </div>

      {events.length > 0 && (
        <div className="mt-4 grid max-h-[28rem] gap-2 overflow-y-auto rounded-xl bg-black/40 p-3 font-mono text-xs">
          {events.map((e, i) => (
            <EventLine key={i} e={e} />
          ))}
          {running && <div className="animate-pulse text-slate-500">thinking…</div>}
          <div ref={bottom} />
        </div>
      )}
    </div>
  );
}

function EventLine({ e }: { e: RunEvent }) {
  switch (e.type) {
    case "start":
      return <div className="text-slate-400">▶ {e.task} <span className="text-slate-600">· {e.model}</span></div>;
    case "tool":
      return (
        <div className="text-sky-300">
          → {e.name} <span className="text-slate-500">{JSON.stringify(e.args)}</span>
        </div>
      );
    case "invoice":
      return <div className="text-slate-300">402 from {e.vendorName}: invoice {fmt(e.amount)} {SYMBOL}</div>;
    case "escrow":
      return (
        <div className="text-sky-200">
          🔒 {fmt(e.amount)} {SYMBOL} locked in escrow for {e.vendorName}
          {e.explorer && <a className="ml-2 text-sol-purple" href={e.explorer} target="_blank">tx ↗</a>}
        </div>
      );
    case "waiting":
      return <div className="text-amber-200/80">… {e.message}</div>;
    case "payment": {
      const [icon, color, label] = OUTCOME[e.outcome];
      return (
        <div className={color}>
          {icon} {fmt(e.amount)} {SYMBOL} {e.vendorName}: {label}
          {e.outcome !== "accepted" && e.reason && <span className="text-slate-400"> · {e.reason}</span>}
          {e.explorer && <a className="ml-2 text-sol-purple" href={e.explorer} target="_blank">tx ↗</a>}
        </div>
      );
    }
    case "answer":
      return <div className="whitespace-pre-wrap rounded-lg bg-white/5 p-3 font-sans text-sm text-slate-100">{e.text}</div>;
    case "error":
      return <div className="text-rose-300">✖ {e.message}</div>;
  }
}

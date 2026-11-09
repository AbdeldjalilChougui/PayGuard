// Runs the agent from the terminal against the demo vault (server must be up
// for the vendor URLs): pnpm agent "Prepare a short market brief on Solana"
import { runAgent, runAttack } from "./agent.js";
import { loadConfig } from "./env.js";

const cfg = loadConfig();
const task = process.argv.slice(2).join(" ") || "Prepare a short market brief on Solana: price and latest news.";

const print = (e: Record<string, any>) => {
  switch (e.type) {
    case "start": return console.log(`▶ ${e.task}\n  vault ${e.vault} · ${e.model}`);
    case "tool": return console.log(`  → ${e.name} ${JSON.stringify(e.args)}`);
    case "invoice": return console.log(`  402 from ${e.vendorName}: ${e.amount} ${cfg.symbol}`);
    case "escrow": return console.log(`  🔒 escrow ${e.amount} ${cfg.symbol} for ${e.vendorName}`);
    case "waiting": return console.log(`  … ${e.message}`);
    case "payment": {
      const icon = { accepted: "✅", disputed: "↩️ ", refunded: "↩️ ", blocked: "⛔", failed: "❌" }[e.outcome as string];
      return console.log(`  ${icon} ${e.outcome} ${e.amount} ${cfg.symbol} ${e.vendorName}${e.code ? ` (${e.code}: ${e.reason})` : ""}\n     ${e.explorer ?? ""}`);
    }
    case "answer": return console.log(`\n${e.text}`);
    case "error": return console.log(`✖ ${e.message}`);
  }
};

const job = task === "attack" ? runAttack(cfg.vault, print) : runAgent(task, cfg.vault, print);
job.then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

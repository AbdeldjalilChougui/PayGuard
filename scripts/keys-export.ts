// Prints the PAYGUARD_KEYS value for a host's secret environment variable.
// These are devnet demo keys only. Paste the output straight into Render and
// do not share it anywhere else.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../server/env.js";

const dir = path.resolve(ROOT, process.env.KEYS_DIR ?? ".keys");
const keys: Record<string, number[]> = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "testwallet.json" && f !== "e2e-agent.json")) {
  keys[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
}
console.error(`# ${Object.keys(keys).length} keys: ${Object.keys(keys).join(", ")}`);
process.stdout.write(JSON.stringify(keys) + "\n");

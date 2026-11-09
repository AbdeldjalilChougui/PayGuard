// Fresh demo agent with a full daily budget: a new agent key added to the
// same vault. The old key is kept in .keys/retired/.
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { Wallet } from "@anchor-lang/core";
import { fetchVault, getProgram } from "@payguard/sdk";
import { VENDORS } from "../server/catalog.js";
import { connection, hasKey, keyPath, loadConfig, loadKey, writeConfig } from "../server/env.js";
import { addDemoAgent, fund, keypair } from "./setup.js";

async function main() {
  const cfg = loadConfig();
  const owner = loadKey("owner");
  if (hasKey("agent")) {
    mkdirSync(path.join(path.dirname(keyPath("agent")), "retired"), { recursive: true });
    renameSync(keyPath("agent"), path.join(path.dirname(keyPath("agent")), "retired", `agent-${Date.now()}.json`));
  }
  const agent = keypair("agent");
  await fund(owner, agent.publicKey, 0.05);
  const vault = new PublicKey(cfg.vault);
  const vendorPdas = Object.fromEntries(VENDORS.map((v) => [v.key, new PublicKey(cfg.vendors[v.key].pda)]));
  const agentPolicy = await addDemoAgent(owner, vault, agent.publicKey, vendorPdas);

  // A paused vault from the last demo would block every scene.
  const program = getProgram(connection, new Wallet(owner));
  if ((await fetchVault(program, vault))?.paused) await program.methods.setVaultPaused(false).accountsPartial({ owner: owner.publicKey, vault }).rpc();

  writeConfig({ ...cfg, agent: agent.publicKey.toBase58(), agentPolicy: agentPolicy.toBase58() });
  console.log(`new agent ${agent.publicKey.toBase58()}\npolicy ${agentPolicy.toBase58()}\nopen http://localhost:5173/?vault=${cfg.vault}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

// Devnet setup, safe to re-run: demo owner, test mint (dUSDC), marketplace
// vendors, the demo vault and agent, and payguard.config.json.
// Your deploy wallet (~/.config/solana/id.json) only funds the demo keys; it
// is never needed by the server.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  BN, PROGRAM_ID, agentPda, fetchAgent, fetchVault, fetchVendor, getProgram, toUnits, vaultPda, vaultTokenOf, vendorPda,
} from "@payguard/sdk";
import { ATTACKER_VENDOR, DEMO_RULES, VENDORS } from "../server/catalog.js";
import {
  BASE_URL, CONFIG_PATH, Wallet, PUBLIC_RPC, RPC_URL, type Config, connection, hasKey, keyPath, loadConfig, loadKey, readKeypair,
  writeConfig,
} from "../server/env.js";
import os from "node:os";

export const DECIMALS = 6;
export const SYMBOL = "dUSDC";

export function keypair(name: string): Keypair {
  if (hasKey(name)) return loadKey(name);
  const kp = Keypair.generate();
  mkdirSync(path.dirname(keyPath(name)), { recursive: true });
  writeFileSync(keyPath(name), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export async function fund(from: Keypair, to: PublicKey, sol: number) {
  if ((await connection.getBalance(to)) >= (sol / 2) * LAMPORTS_PER_SOL) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
  );
  await sendAndConfirmTransaction(connection, tx, [from]);
}

export const deployer = () => readKeypair(process.env.DEPLOYER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json"));

/** Adds an agent to the vault with the demo rules. */
export async function addDemoAgent(owner: Keypair, vault: PublicKey, agent: PublicKey, vendorPdas: Record<string, PublicKey>) {
  const program = getProgram(connection, new Wallet(owner));
  const agentPolicy = agentPda(vault, agent);
  if (await fetchAgent(program, agentPolicy)) return agentPolicy;
  const rules = VENDORS.filter((v) => v.approved).map((v) => ({
    vendor: vendorPdas[v.key],
    dailyCap: toUnits(v.dailyCap, DECIMALS),
  }));
  await program.methods
    .addAgent(toUnits(DEMO_RULES.perTxCap, DECIMALS), toUnits(DEMO_RULES.dailyLimit, DECIMALS), rules)
    .accountsPartial({ owner: owner.publicKey, vault, agent, agentPolicy })
    .rpc();
  return agentPolicy;
}

async function main() {
  const payer = deployer();
  const previous = existsSync(CONFIG_PATH) ? loadConfig() : null;
  console.log(`RPC ${RPC_URL.replace(/api-key=.*/, "api-key=***")}\nprogram ${PROGRAM_ID.toBase58()}\nlistings at ${BASE_URL}`);

  const owner = keypair("owner");
  const agent = keypair("agent");
  const attacker = keypair("attacker");
  const crank = keypair("crank");
  const vendorKeys = Object.fromEntries(VENDORS.map((v) => [v.key, keypair(`vendor-${v.key}`)]));

  // Devnet SOL is scarce: small amounts, topped up only when low.
  await fund(payer, owner.publicKey, 0.4);
  for (const [kp, sol] of [[agent, 0.05], [crank, 0.03], [attacker, 0.02], ...Object.values(vendorKeys).map((k) => [k, 0.015])] as [Keypair, number][]) {
    await fund(owner, kp.publicKey, sol);
  }
  console.log(`owner ${owner.publicKey.toBase58()} (demo owner, mint authority)`);

  const mint = previous?.mint ? new PublicKey(previous.mint) : await createMint(connection, owner, owner.publicKey, null, DECIMALS);
  console.log(`mint ${SYMBOL} ${mint.toBase58()}`);

  // Marketplace listings. Re-running updates URLs (e.g. after moving to Render).
  const vendorPdas: Record<string, PublicKey> = {};
  const listings = [
    ...VENDORS.map((v) => ({ key: v.key, kp: vendorKeys[v.key], name: v.name, path: v.path, price: v.price })),
    { key: "attacker", kp: attacker, ...ATTACKER_VENDOR },
  ];
  for (const l of listings) {
    const program = getProgram(connection, new Wallet(l.kp));
    const pda = vendorPda(l.kp.publicKey);
    vendorPdas[l.key] = pda;
    const url = `${BASE_URL}${l.path}`;
    const existing = await fetchVendor(program, pda);
    if (!existing) {
      await program.methods
        .registerVendor(l.name, url, toUnits(l.price, DECIMALS), l.kp.publicKey)
        .accountsPartial({ authority: l.kp.publicKey, mint, vendor: pda })
        .rpc();
    } else if (existing.url !== url) {
      await program.methods.updateVendor(url, existing.price, existing.active).accountsPartial({ authority: l.kp.publicKey, vendor: pda }).rpc();
    }
    await getOrCreateAssociatedTokenAccount(connection, owner, mint, l.kp.publicKey);
    console.log(`vendor ${l.name.padEnd(18)} ${pda.toBase58()}`);
  }

  // Demo vault, owned by the demo owner.
  const program = getProgram(connection, new Wallet(owner));
  const vault = vaultPda(owner.publicKey, mint);
  const ownerToken = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
  if (!(await fetchVault(program, vault))) {
    await mintTo(connection, owner, mint, ownerToken.address, owner, 1_000 * 10 ** DECIMALS);
    await program.methods
      .createVault(new BN(DEMO_RULES.receiptTimeout), new BN(DEMO_RULES.disputeWindow))
      .accountsPartial({ owner: owner.publicKey, mint, vault, vaultToken: vaultTokenOf(vault, mint) })
      .rpc();
    await program.methods
      .deposit(toUnits(DEMO_RULES.deposit, DECIMALS))
      .accountsPartial({ owner: owner.publicKey, vault, mint, vaultToken: vaultTokenOf(vault, mint), ownerToken: ownerToken.address })
      .rpc();
  }
  const agentPolicy = await addDemoAgent(owner, vault, agent.publicKey, vendorPdas);
  console.log(`vault ${vault.toBase58()}\nagent ${agent.publicKey.toBase58()} policy ${agentPolicy.toBase58()}`);

  const cfg: Config = {
    rpc: PUBLIC_RPC, // never write a keyed RPC URL into a committed file
    programId: PROGRAM_ID.toBase58(),
    mint: mint.toBase58(),
    decimals: DECIMALS,
    symbol: SYMBOL,
    owner: owner.publicKey.toBase58(),
    vault: vault.toBase58(),
    agent: agent.publicKey.toBase58(),
    agentPolicy: agentPolicy.toBase58(),
    attacker: attacker.publicKey.toBase58(),
    crank: crank.publicKey.toBase58(),
    receiptTimeout: DEMO_RULES.receiptTimeout,
    disputeWindow: DEMO_RULES.disputeWindow,
    vendors: Object.fromEntries(
      [...VENDORS, { key: "attacker", ...ATTACKER_VENDOR, approved: false, dailyCap: 0 }].map((v) => [
        v.key,
        {
          name: v.name,
          authority: (v.key === "attacker" ? attacker : vendorKeys[v.key]).publicKey.toBase58(),
          pda: vendorPdas[v.key].toBase58(),
          price: v.price,
          path: v.path,
          approved: v.approved,
          ...(v.dailyCap ? { dailyCap: v.dailyCap } : {}),
        },
      ]),
    ),
  };
  writeConfig(cfg);
  console.log(`wrote payguard.config.json (+ web copy)\nopen http://localhost:5173/?vault=${vault.toBase58()}`);
}

if (process.argv[1]?.endsWith("setup.ts")) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

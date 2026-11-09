// Node-only setup shared by the server, the MCP server and the scripts:
// environment, RPC connection, keypairs and the demo config file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair } from "@solana/web3.js";
import { config as loadEnv } from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: [path.join(ROOT, "server/.env"), path.join(ROOT, "web/.env.local")], quiet: true });

export const RPC_URL = process.env.SOLANA_RPC_URL || process.env.VITE_RPC_URL || "https://api.devnet.solana.com";
export const PUBLIC_RPC = "https://api.devnet.solana.com";
export const connection = new Connection(RPC_URL, "confirmed");
export const PORT = Number(process.env.PORT ?? 4000);
export const BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

const KEYS_DIR = path.resolve(ROOT, process.env.KEYS_DIR ?? ".keys");
export const keyPath = (name: string) => path.join(KEYS_DIR, `${name}.json`);

export const readKeypair = (file: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));

// On a host like Render, all demo keys can come in one secret env var:
// PAYGUARD_KEYS={"agent":[...secret bytes],"owner":[...],...}
// (`pnpm keys:export` prints it). Otherwise they are files in KEYS_DIR.
const envKeys: Record<string, number[]> = process.env.PAYGUARD_KEYS ? JSON.parse(process.env.PAYGUARD_KEYS) : {};

/** A demo keypair, from PAYGUARD_KEYS or KEYS_DIR. */
export const loadKey = (name: string) =>
  envKeys[name] ? Keypair.fromSecretKey(Uint8Array.from(envKeys[name])) : readKeypair(keyPath(name));
export const hasKey = (name: string) => name in envKeys || existsSync(keyPath(name));

/** Mint authority and fee payer for setup and the faucet. */
export function ownerKeypair(): Keypair {
  if (hasKey("owner")) return loadKey("owner");
  return readKeypair(process.env.OWNER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json"));
}

export type VendorConfig = {
  name: string;
  authority: string;
  pda: string;
  price: number;
  path: string;
  approved: boolean;
  dailyCap?: number;
};

export type Config = {
  rpc: string;
  programId: string;
  mint: string;
  decimals: number;
  symbol: string;
  owner: string;
  vault: string;
  agent: string;
  agentPolicy: string;
  attacker: string;
  crank: string;
  receiptTimeout: number;
  disputeWindow: number;
  vendors: Record<string, VendorConfig>;
};

export const CONFIG_PATH = path.join(ROOT, "payguard.config.json");
export const WEB_CONFIG_PATH = path.join(ROOT, "web/src/payguard.config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) throw new Error("Missing payguard.config.json: run `pnpm setup` first");
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function writeConfig(cfg: Config) {
  const text = JSON.stringify(cfg, null, 2) + "\n";
  writeFileSync(CONFIG_PATH, text);
  writeFileSync(WEB_CONFIG_PATH, text);
}

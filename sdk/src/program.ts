// Accounts, PDAs and reads. Works in Node and in the browser.
import { AnchorProvider, Program, type Idl, type Wallet } from "@anchor-lang/core";
import { BN } from "./bn.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import idlJson from "./idl/payguard.json" with { type: "json" };

export const idl = idlJson as Idl;
export const PROGRAM_ID = new PublicKey(idlJson.address);

const enc = new TextEncoder();
const seed = (s: string) => enc.encode(s);
const find = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const vaultPda = (owner: PublicKey, mint: PublicKey) => find([seed("vault"), owner.toBytes(), mint.toBytes()]);
export const agentPda = (vault: PublicKey, agent: PublicKey) => find([seed("agent"), vault.toBytes(), agent.toBytes()]);
export const vendorPda = (authority: PublicKey) => find([seed("vendor"), authority.toBytes()]);
export const escrowPda = (agentPolicy: PublicKey, nonce: Uint8Array) => find([seed("escrow"), agentPolicy.toBytes(), nonce]);
export const vaultTokenOf = (vault: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, vault, true);

export type VaultState = {
  owner: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  paused: boolean;
  locked: BN;
  agentCount: number;
  receiptTimeout: BN;
  disputeWindow: BN;
  bump: number;
};
export type VendorRule = { vendor: PublicKey; dailyCap: BN; spentToday: BN };
export type AgentState = {
  vault: PublicKey;
  agent: PublicKey;
  perTxCap: BN;
  dailyLimit: BN;
  spentToday: BN;
  dayStart: BN;
  totalSpent: BN;
  totalRefunded: BN;
  payCount: BN;
  paused: boolean;
  rules: VendorRule[];
  bump: number;
};
export type VendorState = {
  authority: PublicKey;
  payTo: PublicKey;
  mint: PublicKey;
  name: string;
  url: string;
  price: BN;
  active: boolean;
  sales: BN;
  delivered: BN;
  refunded: BN;
  disputed: BN;
  revenue: BN;
  createdAt: BN;
  bump: number;
};
export type EscrowState = {
  vault: PublicKey;
  agentPolicy: PublicKey;
  vendor: PublicKey;
  payer: PublicKey;
  amount: BN;
  nonce: number[];
  createdAt: BN;
  deadline: BN;
  disputeEnd: BN;
  status: { locked?: object; delivered?: object };
  receiptHash: number[];
  bump: number;
};
export type Row<T> = { publicKey: PublicKey; account: T };

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error("read-only client");
  },
  signAllTransactions: async () => {
    throw new Error("read-only client");
  },
};

/** Anchor client. Pass a wallet to sign, or nothing for reads. */
export function getProgram(connection: Connection, wallet?: Omit<Wallet, "payer">, commitment: Commitment = "confirmed") {
  const provider = new AnchorProvider(connection, (wallet ?? readOnlyWallet) as Wallet, { commitment });
  return new Program(idl, provider);
}
export type PayGuardProgram = ReturnType<typeof getProgram>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acc = (p: PayGuardProgram) => p.account as any;

export const fetchVault = (p: PayGuardProgram, a: PublicKey) => acc(p).vault.fetchNullable(a) as Promise<VaultState | null>;
export const fetchAgent = (p: PayGuardProgram, a: PublicKey) => acc(p).agentPolicy.fetchNullable(a) as Promise<AgentState | null>;
export const fetchVendor = (p: PayGuardProgram, a: PublicKey) => acc(p).vendor.fetchNullable(a) as Promise<VendorState | null>;
export const fetchEscrow = (p: PayGuardProgram, a: PublicKey) => acc(p).escrow.fetchNullable(a) as Promise<EscrowState | null>;

const by = (offset: number, key: PublicKey) => [{ memcmp: { offset, bytes: key.toBase58() } }];

export const allVendors = (p: PayGuardProgram) => acc(p).vendor.all() as Promise<Row<VendorState>[]>;
export const ownerVaults = (p: PayGuardProgram, owner: PublicKey) =>
  acc(p).vault.all(by(8, owner)) as Promise<Row<VaultState>[]>;
export const vaultAgents = (p: PayGuardProgram, vault: PublicKey) =>
  acc(p).agentPolicy.all(by(8, vault)) as Promise<Row<AgentState>[]>;
export const vaultEscrows = (p: PayGuardProgram, vault: PublicKey) =>
  acc(p).escrow.all(by(8, vault)) as Promise<Row<EscrowState>[]>;
export const allEscrows = (p: PayGuardProgram) => acc(p).escrow.all() as Promise<Row<EscrowState>[]>;

export const isDelivered = (e: EscrowState) => "delivered" in e.status;

/** Share of finished sales the vendor delivered without refund or dispute. */
export function reputation(v: Pick<VendorState, "delivered" | "refunded" | "disputed">) {
  const done = v.delivered.toNumber() + v.refunded.toNumber() + v.disputed.toNumber();
  return done === 0 ? null : v.delivered.toNumber() / done;
}

export const toUnits = (amount: number, decimals: number) => new BN(Math.round(amount * 10 ** decimals));
export const fromUnits = (units: { toString(): string } | number | bigint, decimals: number) =>
  Number(units.toString()) / 10 ** decimals;

export const toHex = (b: Uint8Array | number[]) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

export async function sha256(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export const RULE_TEXT: Record<string, string> = {
  VaultPaused: "Vault is paused by its owner",
  AgentPaused: "Agent is paused by its owner",
  VendorNotAllowed: "Vendor not approved for this agent",
  VendorInactive: "Vendor listing is inactive",
  OverListedPrice: "Invoice above the vendor's listed price",
  OverPerTxCap: "Over the per-payment cap",
  OverDailyLimit: "Over the agent's daily limit",
  OverVendorBudget: "Over this vendor's daily budget",
  FundsLocked: "Not enough free funds in the vault",
  ConstraintHasOne: "This key has no authority for that action",
};

/** Pulls the Anchor error out of failed-transaction logs. */
export function parseError(logs: string[] | null | undefined) {
  for (const line of logs ?? []) {
    const m = line.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/);
    if (m) return { code: m[1], number: Number(m[2]), message: m[3] };
  }
  return null;
}

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

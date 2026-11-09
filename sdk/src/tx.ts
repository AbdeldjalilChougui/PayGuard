import { Connection, Keypair, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { parseError } from "./program.js";

export type TxResult =
  | { ok: true; signature: string }
  | { ok: false; signature?: string; code: string; message: string };

export async function fetchLogs(connection: Connection, signature: string): Promise<string[]> {
  for (let i = 0; i < 10; i++) {
    try {
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx) return tx.meta?.logMessages ?? [];
    } catch {
      // devnet RPC hiccup: retry
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return [];
}

/**
 * Signs and sends. With `audit`, preflight is skipped so a payment the program
 * rejects still lands on-chain as a failed transaction: the owner sees every
 * attempt, not just the successful ones.
 */
export async function send(
  connection: Connection,
  ixs: TransactionInstruction[],
  signer: Keypair,
  { audit = false } = {},
): Promise<TxResult> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(signer);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: audit, preflightCommitment: "confirmed" });
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs;
    const err = parseError(logs);
    return { ok: false, code: err?.code ?? "SendFailed", message: err?.message ?? (e as Error).message };
  }
  // web3.js 1.99 throws on a failed transaction instead of returning `err`.
  let failure: unknown = null;
  try {
    failure = (await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")).value.err;
  } catch (e) {
    failure = e;
  }
  if (!failure) return { ok: true, signature };
  const err = parseError(await fetchLogs(connection, signature));
  return { ok: false, signature, code: err?.code ?? "TransactionFailed", message: err?.message ?? JSON.stringify(failure) };
}

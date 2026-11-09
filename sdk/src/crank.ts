// Settles escrows nobody touched: pays vendors after the dispute window and
// refunds vaults after a missed receipt deadline. Anyone can run it.
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair } from "@solana/web3.js";
import { allEscrows, fetchVault, fetchVendor, getProgram, isDelivered, vaultTokenOf } from "./program.js";
import { send } from "./tx.js";

export type CrankResult = { released: number; refunded: number; failed: number };

/** Margin for the gap between this machine's clock and the cluster clock. */
const SLACK = 3;

export async function crankOnce(connection: Connection, payer: Keypair, log?: (m: string) => void): Promise<CrankResult> {
  const program = getProgram(connection);
  const now = Math.floor(Date.now() / 1000);
  const out: CrankResult = { released: 0, refunded: 0, failed: 0 };

  for (const { publicKey: escrow, account: e } of await allEscrows(program)) {
    if (isDelivered(e) && now > e.disputeEnd.toNumber() + SLACK) {
      const [vendor, vault] = await Promise.all([fetchVendor(program, e.vendor), fetchVault(program, e.vault)]);
      if (!vendor || !vault) continue;
      const vendorToken = getAssociatedTokenAddressSync(vault.mint, vendor.payTo, true);
      const ix = await program.methods
        .release()
        .accountsPartial({
          escrow,
          payer: e.payer,
          vault: e.vault,
          vaultToken: vaultTokenOf(e.vault, vault.mint),
          mint: vault.mint,
          vendor: e.vendor,
          vendorToken,
        })
        .instruction();
      const ata = createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vendorToken, vendor.payTo, vault.mint);
      const r = await send(connection, [ata, ix], payer);
      r.ok ? out.released++ : out.failed++;
      log?.(`crank: release ${escrow.toBase58().slice(0, 8)}… ${r.ok ? "ok" : r.code}`);
    } else if (!isDelivered(e) && now > e.deadline.toNumber() + SLACK) {
      const ix = await program.methods
        .refundExpired()
        .accountsPartial({ escrow, payer: e.payer, agentPolicy: e.agentPolicy, vault: e.vault, vendor: e.vendor })
        .instruction();
      const r = await send(connection, [ix], payer);
      r.ok ? out.refunded++ : out.failed++;
      log?.(`crank: refund ${escrow.toBase58().slice(0, 8)}… ${r.ok ? "ok" : r.code}`);
    }
  }
  return out;
}

/** Runs the crank every `intervalMs`. Returns a stop function. */
export function startCrank(connection: Connection, payer: Keypair, intervalMs = 10_000, log?: (m: string) => void) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await crankOnce(connection, payer, log);
    } catch (e) {
      log?.(`crank error: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

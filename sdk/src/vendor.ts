// Vendor side: answer 402 with an escrow invoice, check the escrow on-chain,
// commit to the response with a receipt, then deliver it.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, fetchEscrow, getProgram, sha256, toHex, toUnits, vendorPda, type EscrowState } from "./program.js";
import { send } from "./tx.js";
import { NETWORK, SCHEME, decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired } from "./x402.js";

/** The parts of Express (or any Node framework) the paywall needs. */
export type Req = { headers: Record<string, string | string[] | undefined>; originalUrl?: string; url?: string };
export type Res = {
  status(code: number): Res;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  send(body: string): unknown;
};

export type PaywallOptions = {
  connection: Connection;
  /** Signs receipts. The vendor PDA is derived from it. */
  authority: Keypair;
  name: string;
  description: string;
  /** Listed price, in tokens. */
  price: number;
  decimals: number;
  mint: PublicKey;
  /** Public base URL, used for the `resource` field. */
  baseUrl?: string;
  /** Invoice amount if different from the price (lets the demo overcharge). */
  invoiceAmount?: number;
  /** Receipt deadline the vendor promises, in seconds. */
  maxTimeoutSeconds?: number;
  mimeType?: string;
  /** Turns the handler's data into the response body. Defaults to JSON. */
  serialize?: (data: unknown) => string;
  log?: (msg: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomNonce = () => crypto.getRandomValues(new Uint8Array(16));

export function invoice(opts: PaywallOptions, resource: string): PaymentRequired {
  const vendor = vendorPda(opts.authority.publicKey);
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: SCHEME,
        network: NETWORK,
        maxAmountRequired: toUnits(opts.invoiceAmount ?? opts.price, opts.decimals).toString(),
        asset: opts.mint.toBase58(),
        payTo: vendor.toBase58(),
        resource,
        description: opts.description,
        mimeType: opts.mimeType ?? "application/json",
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
        extra: { nonce: toHex(randomNonce()), vendorName: opts.name, programId: PROGRAM_ID.toBase58(), decimals: opts.decimals },
      },
    ],
  };
}

/**
 * Checks the X-PAYMENT header against the chain. Returns the escrow when it is
 * locked for this vendor with enough money, or a reason.
 */
export async function verifyPayment(
  opts: Pick<PaywallOptions, "connection" | "authority" | "price" | "decimals">,
  header: string | undefined,
): Promise<{ ok: true; escrow: PublicKey; state: EscrowState } | { ok: false; reason: string }> {
  const p = decodeHeader<PaymentPayload>(header);
  if (!p || p.scheme !== SCHEME) return { ok: false, reason: "unreadable X-PAYMENT header" };
  let escrow: PublicKey;
  try {
    escrow = new PublicKey(p.payload.escrow);
  } catch {
    return { ok: false, reason: "bad escrow address" };
  }
  const program = getProgram(opts.connection);
  let state: EscrowState | null = null;
  for (let i = 0; i < 6 && !state; i++) {
    state = await fetchEscrow(program, escrow);
    if (!state) await sleep(600);
  }
  if (!state) return { ok: false, reason: "escrow not found" };
  if (!state.vendor.equals(vendorPda(opts.authority.publicKey))) return { ok: false, reason: "escrow is for another vendor" };
  if (!("locked" in state.status)) return { ok: false, reason: "escrow already used" };
  if (toHex(state.nonce) !== p.payload.nonce) return { ok: false, reason: "nonce does not match" };
  if (state.amount.lt(toUnits(opts.price, opts.decimals))) return { ok: false, reason: "escrow amount below price" };
  return { ok: true, escrow, state };
}

/** Commits on-chain to exactly this body. Fails if the escrow was already used. */
export async function postReceipt(connection: Connection, authority: Keypair, escrow: PublicKey, vault: PublicKey, body: string) {
  const hash = await sha256(body);
  const ix = await getProgram(connection)
    .methods.postReceipt(Array.from(hash))
    .accountsPartial({ authority: authority.publicKey, vendor: vendorPda(authority.publicKey), vault, escrow })
    .instruction();
  return { ...(await send(connection, [ix], authority)), hash: toHex(hash) };
}

/**
 * Express-style handler that sells `handler`'s result through PayGuard escrow.
 *   app.get("/prices", paywall(opts, async (req) => getPrices()))
 */
export function paywall<R extends Req>(opts: PaywallOptions, handler: (req: R) => Promise<unknown>) {
  const serialize = opts.serialize ?? ((d: unknown) => JSON.stringify(d));
  return async (req: R, res: Res) => {
    const resource = `${opts.baseUrl ?? ""}${req.originalUrl ?? req.url ?? ""}`;
    const header = req.headers["x-payment"];
    if (!header) return res.status(402).json(invoice(opts, resource));

    const paid = await verifyPayment(opts, Array.isArray(header) ? header[0] : header);
    if (!paid.ok) return res.status(402).json({ ...invoice(opts, resource), error: paid.reason });

    let body: string;
    try {
      body = serialize(await handler(req));
    } catch (e) {
      // Nothing delivered, no receipt: the agent gets its refund after the deadline.
      return res.status(500).json({ error: (e as Error).message });
    }
    const receipt = await postReceipt(opts.connection, opts.authority, paid.escrow, paid.state.vault, body);
    if (!receipt.ok) return res.status(402).json({ ...invoice(opts, resource), error: `receipt failed: ${receipt.code}` });
    opts.log?.(`${opts.name}: delivered against escrow ${paid.escrow.toBase58().slice(0, 8)}…`);

    res.setHeader(
      "X-PAYMENT-RESPONSE",
      encodeHeader({ success: true, escrow: paid.escrow.toBase58(), receipt: receipt.signature, receiptHash: receipt.hash }),
    );
    res.setHeader("Content-Type", opts.mimeType ?? "application/json");
    return res.status(200).send(body);
  };
}

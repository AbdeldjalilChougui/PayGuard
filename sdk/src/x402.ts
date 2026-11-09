// x402 messages for the PayGuard escrow scheme.
// The 402 body follows the x402 shape ({ x402Version, accepts: [requirements] })
// with scheme "payguard-escrow": payment goes into an on-chain escrow that the
// vendor can only claim by posting a receipt of what it delivered.

export const SCHEME = "payguard-escrow";
export const NETWORK = "solana-devnet";

export type PaymentRequirements = {
  scheme: typeof SCHEME;
  network: string;
  /** Amount in base units (string, x402 style). */
  maxAmountRequired: string;
  /** Token mint. */
  asset: string;
  /** Vendor PDA in the PayGuard marketplace. */
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { nonce: string; vendorName: string; programId: string; decimals: number };
};

export type PaymentRequired = { x402Version: 1; error: string; accepts: PaymentRequirements[] };

/** Sent by the agent in the X-PAYMENT header (base64 JSON). */
export type PaymentPayload = {
  x402Version: 1;
  scheme: typeof SCHEME;
  network: string;
  payload: { escrow: string; signature: string; nonce: string };
};

/** Returned by the vendor in the X-PAYMENT-RESPONSE header (base64 JSON). */
export type PaymentResponse = { success: boolean; escrow: string; receipt: string; receiptHash: string; error?: string };

// btoa/atob exist in browsers and Node 16+; UTF-8 safe through TextEncoder.
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

export const encodeHeader = (v: object) => b64(JSON.stringify(v));
export const decodeHeader = <T>(v: string | null | undefined): T | null => {
  if (!v) return null;
  try {
    return JSON.parse(unb64(v)) as T;
  } catch {
    return null;
  }
};

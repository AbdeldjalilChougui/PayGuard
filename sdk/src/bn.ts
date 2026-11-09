// BN from Anchor, loaded so it works everywhere: Anchor's Node build is
// CommonJS and Node 22 does not detect `BN` as a named ESM export, while the
// browser build exposes it directly.
import * as anchor from "@anchor-lang/core";

type BNClass = typeof anchor.BN;
const mod = anchor as unknown as { BN?: BNClass; default?: { BN?: BNClass } };
export const BN: BNClass = (mod.BN ?? mod.default?.BN)!;
export type BN = InstanceType<BNClass>;

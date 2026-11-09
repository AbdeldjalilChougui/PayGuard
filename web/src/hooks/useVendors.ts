import { useEffect, useState } from "react";
import { allVendors, type PayGuardProgram, type Row, type VendorState } from "@payguard/sdk";
import { rememberVendor } from "../lib/pg";

// One shared listing for every component: requests are de-duplicated and the
// last result is reused, so remounts don't wait on the RPC again.
let cached: Row<VendorState>[] | null = null;
let inflight: Promise<Row<VendorState>[]> | null = null;

function fetchVendors(program: PayGuardProgram) {
  inflight ??= allVendors(program)
    .then((rows) => {
      rows.forEach((r) => rememberVendor(r.publicKey.toBase58(), r.account.name));
      cached = rows.sort((a, b) => a.account.name.localeCompare(b.account.name));
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** All marketplace listings, refreshed every 15s. */
export function useVendors(program: PayGuardProgram) {
  const [vendors, setVendors] = useState<Row<VendorState>[] | null>(cached);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchVendors(program)
        .then((rows) => alive && setVendors(rows))
        .catch(() => alive && setVendors((v) => v ?? []));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [program]);
  return vendors;
}

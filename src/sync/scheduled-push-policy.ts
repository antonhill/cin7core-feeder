// Default-deny gate for the SCHEDULED (cron) outbound master-data push - the /api/sync route that PUTs/POSTs canonical products, customers, suppliers
// and their Category/Brand/UOM reference entries to Cin7. Being CONNECTED (cin7_instances.active) is not authority to write master data: until this
// gate, every active instance was pushed automatically, so any import, Migrate pull or edit reached the customer's live Cin7 within minutes.
//
// An instance is pushed by the scheduler ONLY when its id is listed in CIN7_SCHEDULED_PUSH_INSTANCE_IDS (comma-separated, exact ids). Unset, empty or
// malformed means NO instance is pushed. There is deliberately no wildcard and no "all": widening the gate must name each instance.
//
// This governs the machine actor only. A signed-in user's Import & Sync push (Import module access + write-eligible plan + AAL2), the read-only syncs
// (sales, purchases, stock, production, assembly builds) and the transactional writes (Sales Orders, invoices, purchase orders, fulfilment) are not
// routed through it and are unaffected.

export const SCHEDULED_PUSH_ALLOWLIST_ENV = "CIN7_SCHEDULED_PUSH_INSTANCE_IDS";

// An instance id is a UUID in production; the pattern is only wide enough to reject punctuation and wildcard-looking tokens ("*", "all", "true").
const INSTANCE_ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const NOT_AN_ID = new Set(["all", "true", "yes", "on", "any", "none"]);

/** The instance ids the scheduler may push to. Empty (the default) means none. Malformed entries are ignored, never widened. */
export function scheduledPushAllowedInstanceIds(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  const raw = env[SCHEDULED_PUSH_ALLOWLIST_ENV];
  if (!raw) return new Set();
  const ids = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => INSTANCE_ID_TOKEN.test(t) && !NOT_AN_ID.has(t.toLowerCase()));
  return new Set(ids);
}

export function isScheduledPushAllowed(instanceId: string, env: Record<string, string | undefined> = process.env): boolean {
  return scheduledPushAllowedInstanceIds(env).has(instanceId);
}

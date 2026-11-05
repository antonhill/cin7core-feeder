// Two server-side gates on outbound Cin7 MASTER-DATA pushes (products, customers, suppliers and their Category/Brand/UOM reference entries). Being
// CONNECTED (cin7_instances.active) is not authority to write master data: before these gates every active instance was pushed automatically by the
// cron, so any import, Migrate pull or edit reached the customer's live Cin7 within minutes.
//
// 1. SCHEDULED push is DEFAULT-DENY. The cron pushes an instance ONLY when its id is listed in CIN7_SCHEDULED_PUSH_INSTANCE_IDS (comma-separated, exact
//    ids). Unset, empty or malformed means NO instance is pushed. There is deliberately no wildcard and no "all": widening the gate must name each one.
//
// 2. MANUAL push protection is a NARROW deny-list. An instance listed in CIN7_MANUAL_PUSH_PROTECTED_INSTANCE_IDS cannot receive a master-data push from
//    ANY actor - the scheduler, a signed-in member's Import & Sync push, or the super-admin diagnostics push - until its id is removed from that list.
//    Removing the id is the explicit, separately-made authorisation; it needs a deliberate environment change and a redeploy. Protected wins over the
//    scheduled allow-list, so an id accidentally on both is still refused. Unset or empty protects nothing: it is not a default, it is a named list.
//
// Neither gate touches the read-only syncs (sales, purchases, stock, production, assembly builds), inventory reads, fulfilment, Sales Orders, invoices,
// purchase orders, or Migrate PULLS, which write only to the Toolbox's own tables.

export const SCHEDULED_PUSH_ALLOWLIST_ENV = "CIN7_SCHEDULED_PUSH_INSTANCE_IDS";
export const MANUAL_PUSH_PROTECTED_ENV = "CIN7_MANUAL_PUSH_PROTECTED_INSTANCE_IDS";

/** What a refused manual push says, in the Import page's per-instance alert and the diagnostics result. */
export const MANUAL_PUSH_PROTECTED_MESSAGE =
  "This Cin7 instance is protected from master-data pushes. Nothing was sent to Cin7. The owner must separately authorise pushes to it first.";

// An instance id is a UUID in production; the pattern is only wide enough to reject punctuation and wildcard-looking tokens ("*", "all", "true").
const INSTANCE_ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const NOT_AN_ID = new Set(["all", "true", "yes", "on", "any", "none"]);

type Env = Record<string, string | undefined>;

function parseInstanceIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  const ids = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => INSTANCE_ID_TOKEN.test(t) && !NOT_AN_ID.has(t.toLowerCase()));
  return new Set(ids);
}

/** The instance ids the scheduler may push to. Empty (the default) means none. Malformed entries are ignored, never widened. */
export function scheduledPushAllowedInstanceIds(env: Env = process.env): ReadonlySet<string> {
  return parseInstanceIds(env[SCHEDULED_PUSH_ALLOWLIST_ENV]);
}

export function isScheduledPushAllowed(instanceId: string, env: Env = process.env): boolean {
  return scheduledPushAllowedInstanceIds(env).has(instanceId);
}

/** The instance ids no actor may push master data to. Empty protects nothing. */
export function manualPushProtectedInstanceIds(env: Env = process.env): ReadonlySet<string> {
  return parseInstanceIds(env[MANUAL_PUSH_PROTECTED_ENV]);
}

export function isManualPushProtected(instanceId: string, env: Env = process.env): boolean {
  return manualPushProtectedInstanceIds(env).has(instanceId);
}

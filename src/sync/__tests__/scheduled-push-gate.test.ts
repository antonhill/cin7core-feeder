import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncOrgInstances } from "@/sync/sync-org";
import { syncInstance } from "@/sync/run-sync";
import { logActivity } from "@/lib/activity-log";
import {
  MANUAL_PUSH_PROTECTED_ENV,
  MANUAL_PUSH_PROTECTED_MESSAGE,
  SCHEDULED_PUSH_ALLOWLIST_ENV,
  isManualPushProtected,
  isScheduledPushAllowed,
  manualPushProtectedInstanceIds,
  scheduledPushAllowedInstanceIds,
} from "@/sync/scheduled-push-policy";

vi.mock("@/sync/run-sync", () => ({ syncInstance: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));

// Synthetic ids standing in for the live Cin7 instances the scheduled push had been writing to (LBL and I-Light share an organisation). The gate matches on
// instance id alone, so these prove the behaviour without committing production identifiers.
const LBL = { id: "11111111-1111-4111-8111-111111111111", org: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const I_LIGHT = { id: "22222222-2222-4222-8222-222222222222", org: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const NEWQUIP = { id: "33333333-3333-4333-8333-333333333333", org: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const SPARK_DEMO = { id: "44444444-4444-4444-8444-444444444444", org: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const CASA = { id: "55555555-5555-4555-8555-555555555555", org: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
const ALL = [LBL, I_LIGHT, NEWQUIP, SPARK_DEMO, CASA];

const summary = (instanceId: string) => ({
  instanceId, instanceName: "X", productsCreated: 0, productsUpdated: 0, productsSkipped: 0, productsFailureSuppressed: 0, productsFailed: 0,
  productionBomsPushed: 0, productionBomsFailed: 0, customersCreated: 0, customersUpdated: 0, customersSkipped: 0, customersFailed: 0,
  suppliersCreated: 0, suppliersUpdated: 0, suppliersSkipped: 0, suppliersFailed: 0, errors: [], truncated: false,
});

/** A db that serves only the cin7_instances read syncOrgInstances makes, records every table touched, and counts lock RPCs. It has NO update/delete/insert on cin7_instances. */
function fakeDb(rows: { id: string; org: string }[]) {
  const tables: string[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: true, locked_at: "2026-01-01T00:00:00Z" }], error: null });
  const lockTable = () => { const api = { delete: () => api, eq: () => api, then: (r: (v: { error: null }) => void) => r({ error: null }) }; return api; };
  const instances = () => {
    const eqs: [string, unknown][] = []; let inF: { col: string; values: unknown[] } | undefined;
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => { eqs.push([c, v]); return api; },
      in: (c: string, values: unknown[]) => { inF = { col: c, values }; return api; },
      then: (r: (v: { data: unknown[]; error: null }) => void) => {
        const all = rows.map((x) => ({ id: x.id, org_id: x.org, active: true }));
        r({ data: all.filter((i) => eqs.every(([c, v]) => (i as Record<string, unknown>)[c] === v) && (!inF || inF.values.includes((i as Record<string, unknown>)[inF.col]))), error: null });
      },
    };
    return api;
  };
  const db = { from: (t: string) => { tables.push(t); return t === "sync_locks" || t === "sync_route_locks" ? lockTable() : instances(); }, rpc } as unknown as SupabaseClient;
  return { db, tables, rpc };
}

beforeEach(() => {
  vi.mocked(syncInstance).mockReset();
  vi.mocked(syncInstance).mockImplementation(async (_db, _org, instanceId) => summary(instanceId));
  vi.mocked(logActivity).mockReset();
  vi.stubEnv(SCHEDULED_PUSH_ALLOWLIST_ENV, "");
  vi.stubEnv(MANUAL_PUSH_PROTECTED_ENV, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("scheduled push policy: default-deny, exact instance ids only", () => {
  it.each([[undefined], [""], ["   "], [","], [" , ,"]])("pushes NOTHING when the allow-list is %j", (raw) => {
    const env = { [SCHEDULED_PUSH_ALLOWLIST_ENV]: raw };
    expect(scheduledPushAllowedInstanceIds(env).size).toBe(0);
    for (const i of ALL) expect(isScheduledPushAllowed(i.id, env)).toBe(false);
  });

  it("allows only the exact ids named, tolerating whitespace and trailing commas", () => {
    const env = { [SCHEDULED_PUSH_ALLOWLIST_ENV]: ` ${SPARK_DEMO.id} ,${CASA.id},` };
    expect(isScheduledPushAllowed(SPARK_DEMO.id, env)).toBe(true);
    expect(isScheduledPushAllowed(CASA.id, env)).toBe(true);
    for (const i of [LBL, I_LIGHT, NEWQUIP]) expect(isScheduledPushAllowed(i.id, env)).toBe(false);
  });

  it.each(["*", "all", "ALL", "true", "yes", "on", "any", "none", "%", ".*", "1=1"])("a wildcard-looking value (%s) never widens the gate to LBL or I-Light", (v) => {
    const env = { [SCHEDULED_PUSH_ALLOWLIST_ENV]: v };
    for (const i of [LBL, I_LIGHT]) expect(isScheduledPushAllowed(i.id, env)).toBe(false);
  });

  it("a prefix, a suffix or a longer string containing an id does not match it", () => {
    expect(isScheduledPushAllowed(LBL.id, { [SCHEDULED_PUSH_ALLOWLIST_ENV]: LBL.id.slice(0, 8) })).toBe(false);
    expect(isScheduledPushAllowed(LBL.id, { [SCHEDULED_PUSH_ALLOWLIST_ENV]: LBL.id.slice(8) })).toBe(false);
    expect(isScheduledPushAllowed(LBL.id, { [SCHEDULED_PUSH_ALLOWLIST_ENV]: `x${LBL.id}` })).toBe(false);
  });

  it("only a comma separates ids: a semicolon or space-joined list is ignored, never half-honoured", () => {
    expect(scheduledPushAllowedInstanceIds({ [SCHEDULED_PUSH_ALLOWLIST_ENV]: `${LBL.id};${I_LIGHT.id}` }).size).toBe(0);
    expect(scheduledPushAllowedInstanceIds({ [SCHEDULED_PUSH_ALLOWLIST_ENV]: `${LBL.id} ${I_LIGHT.id}` }).size).toBe(0);
  });

  it("a malformed entry is ignored and does not disturb the valid ids beside it", () => {
    const env = { [SCHEDULED_PUSH_ALLOWLIST_ENV]: `*,${SPARK_DEMO.id},; drop table x;,all` };
    expect([...scheduledPushAllowedInstanceIds(env)]).toEqual([SPARK_DEMO.id]);
  });
});

describe("the scheduler (machine actor) with the safeguard", () => {
  it("DEFAULT: pushes nothing to LBL, I-Light, NewQuip, Casa or Spark Demo, takes no lock, writes no log, and reports each as skippedNotAuthorised", async () => {
    for (const org of [...new Set(ALL.map((i) => i.org))]) {
      const { db, rpc, tables } = fakeDb(ALL);
      const out = await syncOrgInstances(db, org, undefined, {}, "system", 260_000);
      expect(out.length).toBe(ALL.filter((i) => i.org === org).length);
      expect(out.every((o) => o.skippedNotAuthorised === true && o.ok === true && !o.error)).toBe(true);
      expect(rpc).not.toHaveBeenCalled();
      expect(new Set(tables)).toEqual(new Set(["cin7_instances"]));
    }
    expect(syncInstance).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("LBL and I-Light are not pushed even when other instances ARE authorised", async () => {
    vi.stubEnv(SCHEDULED_PUSH_ALLOWLIST_ENV, `${SPARK_DEMO.id},${CASA.id}`);
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, LBL.org, undefined, {}, "system", 260_000);
    expect(syncInstance).not.toHaveBeenCalled();
    expect(out.map((o) => o.instanceId).sort()).toEqual([I_LIGHT.id, LBL.id].sort());
    expect(out.every((o) => o.skippedNotAuthorised)).toBe(true);
  });

  it("an authorised instance is still pushed (explicit opt-in works), and only that one", async () => {
    vi.stubEnv(SCHEDULED_PUSH_ALLOWLIST_ENV, SPARK_DEMO.id);
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, SPARK_DEMO.org, undefined, {}, "system", 260_000);
    expect(vi.mocked(syncInstance).mock.calls.map((c) => c[2])).toEqual([SPARK_DEMO.id]);
    expect(out[0].skippedNotAuthorised).toBeUndefined();
  });

  it("with two instances in one org and only one authorised, the other is skipped and reported, not pushed", async () => {
    vi.stubEnv(SCHEDULED_PUSH_ALLOWLIST_ENV, I_LIGHT.id);
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, LBL.org, undefined, {}, "system", 260_000);
    expect(vi.mocked(syncInstance).mock.calls.map((c) => c[2])).toEqual([I_LIGHT.id]);
    expect(out.find((o) => o.instanceId === LBL.id)?.skippedNotAuthorised).toBe(true);
  });

  it("naming an instance explicitly via instanceIds does not get around the gate for the scheduler", async () => {
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, LBL.org, [LBL.id], {}, "system", 260_000);
    expect(syncInstance).not.toHaveBeenCalled();
    expect(out).toEqual([{ ok: true, instanceId: LBL.id, orgId: LBL.org, skippedNotAuthorised: true }]);
  });

  it("the legacy all-orgs sweep (no orgId) is gated too", async () => {
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, undefined, undefined, {}, "system");
    expect(syncInstance).not.toHaveBeenCalled();
    expect(out.length).toBe(ALL.length);
  });

  it("never mutates cin7_instances: the connection stays active, only a select is issued", async () => {
    const { db, tables } = fakeDb(ALL);
    await syncOrgInstances(db, LBL.org, undefined, {}, "system", 260_000);
    expect(tables).toEqual(["cin7_instances"]);
  });
});

describe("a signed-in user's Import & Sync push is a different, separately gated action and is preserved", () => {
  it("still pushes with the default-deny allow-list empty, and logs the real actor", async () => {
    const actor = { userId: "u1", email: "member@example.test" };
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, LBL.org, [LBL.id], {}, actor, 260_000);
    expect(vi.mocked(syncInstance).mock.calls.map((c) => c[2])).toEqual([LBL.id]);
    expect(out[0].skippedNotAuthorised).toBeUndefined();
    expect(vi.mocked(logActivity).mock.calls[0][1]).toMatchObject({ actor, action: "sync.push", instanceId: LBL.id });
  });
});

describe("manual-push protection: a narrow deny-list that binds EVERY actor", () => {
  const PROTECT_BOTH = `${LBL.id},${I_LIGHT.id}`;
  const user = { userId: "u1", email: "member@example.test" };

  it.each([[undefined], [""], ["  "], [","]])("protects nothing when the list is %j", (raw) => {
    expect(manualPushProtectedInstanceIds({ [MANUAL_PUSH_PROTECTED_ENV]: raw }).size).toBe(0);
    for (const i of ALL) expect(isManualPushProtected(i.id, { [MANUAL_PUSH_PROTECTED_ENV]: raw })).toBe(false);
  });

  it("protects exactly the ids named, and a wildcard-looking value protects nothing rather than everything", () => {
    const env = { [MANUAL_PUSH_PROTECTED_ENV]: PROTECT_BOTH };
    expect(isManualPushProtected(LBL.id, env) && isManualPushProtected(I_LIGHT.id, env)).toBe(true);
    for (const i of [NEWQUIP, SPARK_DEMO, CASA]) expect(isManualPushProtected(i.id, env)).toBe(false);
    for (const v of ["*", "all", "true"]) expect(isManualPushProtected(LBL.id, { [MANUAL_PUSH_PROTECTED_ENV]: v })).toBe(false);
  });

  it("a signed-in user's push to LBL and I-Light is REFUSED with a plain error, takes no lock, calls nothing, and is recorded", async () => {
    vi.stubEnv(MANUAL_PUSH_PROTECTED_ENV, PROTECT_BOTH);
    const { db, rpc } = fakeDb(ALL);
    const out = await syncOrgInstances(db, LBL.org, [LBL.id, I_LIGHT.id], {}, user, 260_000);
    expect(syncInstance).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
    for (const o of out) expect(o).toMatchObject({ ok: false, skippedProtected: true, error: MANUAL_PUSH_PROTECTED_MESSAGE });
    const logged = vi.mocked(logActivity).mock.calls.map((c) => c[1]);
    expect(logged.map((l) => l.action)).toEqual(["sync.push_blocked", "sync.push_blocked"]);
    expect(logged.every((l) => (l.actor as { userId: string }).userId === "u1")).toBe(true);
  });

  it("in one request, the protected instance is refused while an unprotected one is still pushed", async () => {
    vi.stubEnv(MANUAL_PUSH_PROTECTED_ENV, LBL.id);
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, undefined, [LBL.id, SPARK_DEMO.id], {}, user, 260_000);
    expect(vi.mocked(syncInstance).mock.calls.map((c) => c[2])).toEqual([SPARK_DEMO.id]);
    expect(out.find((o) => o.instanceId === LBL.id)).toMatchObject({ ok: false, skippedProtected: true });
    expect(out.find((o) => o.instanceId === SPARK_DEMO.id)?.skippedProtected).toBeUndefined();
  });

  it("PROTECTED WINS over the scheduled allow-list: an id on both lists is not pushed by the cron", async () => {
    vi.stubEnv(SCHEDULED_PUSH_ALLOWLIST_ENV, `${LBL.id},${SPARK_DEMO.id}`);
    vi.stubEnv(MANUAL_PUSH_PROTECTED_ENV, LBL.id);
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, LBL.org, undefined, {}, "system", 260_000);
    expect(syncInstance).not.toHaveBeenCalled();
    expect(out.find((o) => o.instanceId === LBL.id)).toMatchObject({ ok: true, skippedNotAuthorised: true });
    expect(logActivity).not.toHaveBeenCalled(); // the 15-minute cron denial stays silent
  });

  it("removing an id from the list IS the authorisation: only the still-protected instance is refused", async () => {
    vi.stubEnv(MANUAL_PUSH_PROTECTED_ENV, I_LIGHT.id);
    const { db } = fakeDb(ALL);
    const out = await syncOrgInstances(db, LBL.org, [LBL.id, I_LIGHT.id], {}, user, 260_000);
    expect(vi.mocked(syncInstance).mock.calls.map((c) => c[2])).toEqual([LBL.id]);
    expect(out.find((o) => o.instanceId === I_LIGHT.id)?.skippedProtected).toBe(true);
  });

  it("protection leaves the connection active: only selects are issued against cin7_instances", async () => {
    vi.stubEnv(MANUAL_PUSH_PROTECTED_ENV, PROTECT_BOTH);
    const { db, tables } = fakeDb(ALL);
    await syncOrgInstances(db, LBL.org, [LBL.id, I_LIGHT.id], {}, user, 260_000);
    expect(new Set(tables)).toEqual(new Set(["cin7_instances"]));
  });
});

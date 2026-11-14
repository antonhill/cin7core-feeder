// Phase 2 S2: offline CLI for the clearance register and Bond report. Local files only: no network, no Cin7 write, no Xero, no Supabase.
// Terminal output is counts and ids only (never a SKU); full detail goes to a 0600 report file under ~/rwtsa-local/bond.
import { createHash } from "node:crypto";
import { BondRegisterError, foldRegister, validateProposal, type ClearanceEntry, type Destination, type RegisterEvent } from "./engine";
import { appendRegisterEvent, readRegister, writeBondFileAtomic } from "./register-store";
import { buildBondReport } from "./report";
import { assertReconcilable } from "../reconcile";
import { readSnapshotFile } from "../store";
import { RwtsaLiveError } from "../types";
import type { Snapshot } from "../snapshot";

export interface CliEnv { home: string; today: string; now: string }
export interface CliResult { code: number; lines: string[] }

interface Spec { required: string[]; optional?: string[]; repeatable?: string[] }
const SPECS: Record<string, Spec> = {
  "add-clearance": { required: ["shipment", "clearance-ref", "date", "provenance", "attributed-to", "line"], optional: ["document-ref"], repeatable: ["line"] },
  verify: { required: ["entry", "by", "document-ref"] },
  withdraw: { required: ["entry", "by", "reason"] },
  propose: { required: ["snapshot", "sku", "qty", "to", "by", "reason"] },
  "withdraw-proposal": { required: ["id", "by", "reason"] },
  "record-release": { required: ["from-snapshot", "to-snapshot", "sku", "qty", "by"], optional: ["proposal"] },
  report: { required: ["snapshot"], optional: ["previous-snapshot"] },
};
class UsageError extends Error {}

function parse(argv: readonly string[], spec: Spec): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const known = new Set([...spec.required, ...(spec.optional ?? [])]);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith("--") || flag.includes("=")) throw new UsageError(`unexpected argument (flags look like --name value)`);
    const name = flag.slice(2);
    if (!known.has(name)) throw new UsageError(`unknown flag --${name}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} requires a value`);
    if (out.has(name) && !(spec.repeatable ?? []).includes(name)) throw new UsageError(`--${name} given more than once`);
    out.set(name, [...(out.get(name) ?? []), v]);
  }
  for (const r of spec.required) if (!out.has(r)) throw new UsageError(`--${r} is required`);
  return out;
}
const num = (s: string, what: string): number => { const n = Number(s); if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${what} must be a positive number`); return n; };

function loadSnapshot(file: string): Snapshot {
  const s = readSnapshotFile(file);
  assertReconcilable(s, false); // COMPLETE and identity VERIFIED, or refuse
  return s;
}
const bondMap = (s: Snapshot) => new Map(s.stock.map((x) => [x.sku, x.bond] as const));
const usableMap = (s: Snapshot) => new Map(s.stock.map((x) => [x.sku, x.usable] as const));
const countOf = (events: readonly RegisterEvent[], type: RegisterEvent["type"]) => events.filter((e) => e.type === type).length;

export function runBondCli(argv: readonly string[], env: CliEnv): CliResult {
  const [cmd, ...rest] = argv;
  const spec = cmd ? SPECS[cmd] : undefined;
  if (!cmd || !spec) return { code: 2, lines: [`Usage: bond <${Object.keys(SPECS).join(" | ")}> [--flag value ...]`] };
  try {
    const a = parse(rest, spec);
    const one = (n: string) => a.get(n)![0];
    const reg = readRegister({ home: env.home });
    const append = (event: RegisterEvent) => appendRegisterEvent({ home: env.home, event, at: env.now, today: env.today });
    switch (cmd) {
      case "add-clearance": {
        const lines = (a.get("line") ?? []).map((l) => { const k = l.lastIndexOf("="); if (k <= 0) throw new UsageError("--line must be SKU=quantity"); return { sku: l.slice(0, k), quantity: num(l.slice(k + 1), "a --line quantity") }; });
        const id = `CL-${countOf(reg.events, "CLEARANCE_ADDED") + 1}`;
        const entry: ClearanceEntry = { id, shipmentRef: one("shipment"), clearanceRef: one("clearance-ref"), clearanceDate: one("date"), lines, attributedTo: one("attributed-to"), provenance: one("provenance") as ClearanceEntry["provenance"], documentRef: a.get("document-ref")?.[0], recordedOn: env.today };
        append({ type: "CLEARANCE_ADDED", entry });
        return { code: 0, lines: [`Recorded clearance entry ${id} with ${lines.length} SKU line(s). It is UNVERIFIED, which means NOT CLEARED, until verified.`] };
      }
      case "verify": append({ type: "CLEARANCE_VERIFIED", entryId: one("entry"), verifiedBy: one("by"), verifiedOn: env.today, documentRef: one("document-ref") }); return { code: 0, lines: [`Verified clearance entry ${one("entry")}.`] };
      case "withdraw": append({ type: "CLEARANCE_WITHDRAWN", entryId: one("entry"), by: one("by"), on: env.today, reason: one("reason") }); return { code: 0, lines: [`Withdrew clearance entry ${one("entry")}.`] };
      case "propose": {
        const snap = loadSnapshot(one("snapshot"));
        const state = foldRegister(reg.events, { asOf: env.today });
        const to = one("to") as Destination, qty = num(one("qty"), "--qty");
        const check = validateProposal(state, { bondBySku: bondMap(snap), operationalUsableBySku: usableMap(snap) }, { sku: one("sku"), quantity: qty, destination: to });
        if (!check.ok) return { code: 1, lines: [`Proposal refused: ${check.reason}`] };
        const id = `P-${countOf(reg.events, "TRANSFER_PROPOSED") + 1}`;
        append({ type: "TRANSFER_PROPOSED", proposal: { id, sku: one("sku"), quantity: qty, destination: to, proposedBy: one("by"), proposedOn: env.today, reason: one("reason") } });
        return { code: 0, lines: [`Recorded draft transfer proposal ${id} . No Cin7 transaction was created.`] };
      }
      case "withdraw-proposal": append({ type: "PROPOSAL_WITHDRAWN", proposalId: one("id"), by: one("by"), on: env.today, reason: one("reason") }); return { code: 0, lines: [`Withdrew proposal ${one("id")}.`] };
      case "record-release": {
        const from = loadSnapshot(one("from-snapshot")), to = loadSnapshot(one("to-snapshot"));
        if (Date.parse(from.takenAt) >= Date.parse(to.takenAt)) return { code: 1, lines: ["Refused: the from-snapshot must be earlier than the to-snapshot."] };
        const sku = one("sku"), qty = num(one("qty"), "--qty");
        const decrease = Math.max(0, (bondMap(from).get(sku) ?? 0) - (bondMap(to).get(sku) ?? 0));
        const state = foldRegister(reg.events, { asOf: env.today });
        const already = state.releases.filter((r) => r.sku === sku && !r.voided && r.fromHash === from.contentHash && r.toHash === to.contentHash).reduce((t, r) => t + r.quantity, 0);
        if (qty + already - decrease > 1e-9) return { code: 1, lines: [`Refused: only ${Math.max(0, decrease - already)} unit(s) of observed Bond decrease remain unrecorded between these snapshots.`] };
        const id = `R-${countOf(reg.events, "RELEASE_RECORDED") + 1}`;
        append({ type: "RELEASE_RECORDED", id, sku, quantity: qty, on: env.today, recordedBy: one("by"), fromSnapshotHash: from.contentHash, toSnapshotHash: to.contentHash, fromTakenAt: from.takenAt, toTakenAt: to.takenAt, proposalId: a.get("proposal")?.[0] });
        return { code: 0, lines: [`Recorded release ${id} from an observed Bond decrease. This records a movement only; it is not clearance evidence.`] };
      }
      case "report": {
        const snap = loadSnapshot(one("snapshot")), prev = a.has("previous-snapshot") ? loadSnapshot(one("previous-snapshot")) : undefined;
        if (prev && Date.parse(prev.takenAt) >= Date.parse(snap.takenAt)) return { code: 1, lines: ["Refused: the previous snapshot must be earlier than the snapshot."] };
        const state = foldRegister(reg.events, { asOf: env.today });
        const rep = buildBondReport({ snapshot: snap, previous: prev, state, registerTipHash: reg.tipHash, registerEvents: reg.count, generatedAt: env.now });
        const text = JSON.stringify(rep, null, 2);
        const { file } = writeBondFileAtomic({ home: env.home, name: `bond-report-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`, text });
        const s = rep.summary;
        return { code: 0, lines: [
          `BOND REPORT · ${s.skusWithBondStock} SKU(s) with Bond stock · Bond units ${s.bondUnits} · verified cleared ${s.verifiedClearedUnits} · unverified claimed ${s.unverifiedClaimedUnits} · NOT CLEARED SKUs ${s.notClearedSkus}`,
          `  eligible for release ${s.eligibleUnits} · proposed ${s.proposedUnits} · exceptions ${s.exceptionCount} · uncleared observed units ${s.unclearedObservedUnits}`,
          "  Unverified clearance is NOT CLEARED. A transfer, posted duty or freight invoice is never clearance evidence. No Cin7 transaction is created.",
          `  written: ${file.split("/").pop()} (in ~/rwtsa-local/bond)`,
        ] };
      }
    }
  } catch (e) {
    if (e instanceof UsageError) return { code: 2, lines: [`Usage error: ${e.message}`] };
    if (e instanceof BondRegisterError || e instanceof RwtsaLiveError) return { code: 1, lines: [`Refused: ${e.message}`] };
    return { code: 1, lines: ["Failed (details withheld)."] };
  }
  return { code: 2, lines: ["Usage error."] };
}

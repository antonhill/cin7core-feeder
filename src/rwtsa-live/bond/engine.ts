// RWTSA Phase 2 S1: PURE bonded-stock availability and clearance engine. No I/O, no network, no Cin7 write, no clock (asOf is passed in).
//
// Rules this module enforces (each has a test):
//   * Unverified clearance means NOT CLEARED. Only an entry with a recorded verification (verifier, date, document reference) counts.
//   * A stock transfer, posted customs duty, a freight invoice or a landed-cost line is NEVER clearance evidence: the provenance vocabulary is closed and
//     none of those is in it, and nothing here infers clearance from stock movement or cost data.
//   * An OWNER_STATEMENT can be recorded but can never be verified (it stays NOT CLEARED).
//   * Eligible stock = min(physical Bond stock, verified-cleared quantity not yet released). Never negative; never above either bound.
//   * Proposed transfers are drafts: they change no clearance figure and create no Cin7 transaction.
//   * A Bond decrease beyond what was eligible is a TRANSFER_WITHOUT_CLEARANCE_EVIDENCE exception and is never promoted to cleared.
import { ROLES, type Role } from "../types";

export const PROVENANCE = ["CUSTOMS_DOCUMENT", "BROKER_CONFIRMATION", "OWNER_STATEMENT"] as const;
export type Provenance = (typeof PROVENANCE)[number];
export type Destination = Exclude<Role, "BOND">;
export const DESTINATIONS: readonly Destination[] = ROLES.filter((r): r is Destination => r !== "BOND");

export interface ClearanceLine { sku: string; quantity: number }
export interface ClearanceEntry {
  id: string; shipmentRef: string; clearanceRef: string; clearanceDate: string; lines: ClearanceLine[];
  attributedTo: string; provenance: Provenance; documentRef?: string; recordedOn: string;
}
export interface TransferProposal { id: string; sku: string; quantity: number; destination: Destination; proposedBy: string; proposedOn: string; reason: string }
export type RegisterEvent =
  | { type: "CLEARANCE_ADDED"; entry: ClearanceEntry }
  | { type: "CLEARANCE_VERIFIED"; entryId: string; verifiedBy: string; verifiedOn: string; documentRef: string }
  | { type: "CLEARANCE_WITHDRAWN"; entryId: string; by: string; on: string; reason: string }
  | { type: "TRANSFER_PROPOSED"; proposal: TransferProposal }
  | { type: "PROPOSAL_WITHDRAWN"; proposalId: string; by: string; on: string; reason: string }
  | { type: "RELEASE_RECORDED"; id: string; sku: string; quantity: number; on: string; recordedBy: string; fromSnapshotHash: string; toSnapshotHash: string };

export class BondRegisterError extends Error { constructor(message: string) { super(message); this.name = "BondRegisterError"; } }
const fail = (m: string): never => { throw new BondRegisterError(m); };

const EPS = 1e-9;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

interface EntryState { entry: ClearanceEntry; verified?: { by: string; on: string; documentRef: string }; withdrawn?: { by: string; on: string; reason: string } }
export interface RegisterState {
  asOf: string;
  entries: Map<string, EntryState>;
  proposals: Map<string, { proposal: TransferProposal; withdrawn: boolean }>;
  releases: { id: string; sku: string; quantity: number; on: string }[];
}

/** Validates and folds the append-only event list. Throws BondRegisterError (message names the rule, never echoes secrets) on any invalid event. */
export function foldRegister(events: readonly RegisterEvent[], opts: { asOf: string }): RegisterState {
  if (!validDate(opts.asOf)) fail("asOf must be a real YYYY-MM-DD date");
  const st: RegisterState = { asOf: opts.asOf, entries: new Map(), proposals: new Map(), releases: [] };
  const live = (id: string): EntryState => { const e = st.entries.get(id); if (!e) fail(`unknown clearance entry`); const s = e as EntryState; if (s.withdrawn) fail("the clearance entry is withdrawn"); return s; };
  events.forEach((ev, i) => {
    const at = `event ${i + 1}`;
    switch (ev.type) {
      case "CLEARANCE_ADDED": {
        const e = ev.entry;
        if (!nonEmpty(e.id)) fail(`${at}: clearance id required`);
        if (st.entries.has(e.id)) fail(`${at}: duplicate clearance id`);
        if (!nonEmpty(e.shipmentRef)) fail(`${at}: shipment or PO reference required`);
        if (!nonEmpty(e.clearanceRef)) fail(`${at}: customs-clearance reference required`);
        if (!validDate(e.clearanceDate)) fail(`${at}: clearance date must be a real YYYY-MM-DD date`);
        if (e.clearanceDate > opts.asOf) fail(`${at}: clearance date is in the future`);
        if (!validDate(e.recordedOn)) fail(`${at}: recordedOn must be a real YYYY-MM-DD date`);
        if (!nonEmpty(e.attributedTo)) fail(`${at}: owner attribution required`);
        if (!(PROVENANCE as readonly string[]).includes(e.provenance)) fail(`${at}: evidence provenance must be one of ${PROVENANCE.join(", ")} (a transfer, posted duty or freight invoice is not clearance evidence)`);
        if (!Array.isArray(e.lines) || e.lines.length === 0) fail(`${at}: at least one SKU line required`);
        const skus = new Set<string>();
        for (const l of e.lines) {
          if (!nonEmpty(l.sku)) fail(`${at}: line SKU required`);
          if (!positive(l.quantity)) fail(`${at}: cleared quantity must be a positive number`);
          if (skus.has(l.sku)) fail(`${at}: duplicate SKU within the entry`);
          skus.add(l.sku);
        }
        for (const other of st.entries.values()) {
          if (other.withdrawn || other.entry.clearanceRef !== e.clearanceRef) continue;
          if (other.entry.lines.some((l) => skus.has(l.sku))) fail(`${at}: duplicate clearance reference for a SKU already recorded (would count it twice)`);
        }
        st.entries.set(e.id, { entry: { ...e, lines: e.lines.map((l) => ({ ...l })) } });
        break;
      }
      case "CLEARANCE_VERIFIED": {
        const s = live(ev.entryId);
        if (s.verified) fail(`${at}: the clearance entry is already verified`);
        if (!nonEmpty(ev.verifiedBy)) fail(`${at}: verifier required`);
        if (!validDate(ev.verifiedOn)) fail(`${at}: verification date must be a real YYYY-MM-DD date`);
        if (!nonEmpty(ev.documentRef)) fail(`${at}: a document reference is required to verify`);
        if (s.entry.provenance === "OWNER_STATEMENT") fail(`${at}: an owner statement alone cannot be verified as customs clearance`);
        s.verified = { by: ev.verifiedBy, on: ev.verifiedOn, documentRef: ev.documentRef };
        break;
      }
      case "CLEARANCE_WITHDRAWN": {
        const s = live(ev.entryId);
        if (!nonEmpty(ev.by) || !nonEmpty(ev.reason) || !validDate(ev.on)) fail(`${at}: withdrawal needs who, a real date and a reason`);
        s.withdrawn = { by: ev.by, on: ev.on, reason: ev.reason };
        break;
      }
      case "TRANSFER_PROPOSED": {
        const p = ev.proposal;
        if (!nonEmpty(p.id) || st.proposals.has(p.id)) fail(`${at}: proposal id required and unique`);
        if (!nonEmpty(p.sku) || !positive(p.quantity)) fail(`${at}: proposal needs a SKU and a positive quantity`);
        if (!(DESTINATIONS as readonly string[]).includes(p.destination)) fail(`${at}: destination must be a non-Bond location role`);
        if (!nonEmpty(p.proposedBy) || !nonEmpty(p.reason) || !validDate(p.proposedOn)) fail(`${at}: proposal needs who, a real date and a reason`);
        st.proposals.set(p.id, { proposal: { ...p }, withdrawn: false });
        break;
      }
      case "PROPOSAL_WITHDRAWN": {
        const p = st.proposals.get(ev.proposalId);
        if (!p) fail(`${at}: unknown proposal`);
        if (!nonEmpty(ev.by) || !nonEmpty(ev.reason) || !validDate(ev.on)) fail(`${at}: withdrawal needs who, a real date and a reason`);
        (p as { withdrawn: boolean }).withdrawn = true;
        break;
      }
      case "RELEASE_RECORDED": {
        if (!nonEmpty(ev.id) || st.releases.some((r) => r.id === ev.id)) fail(`${at}: release id required and unique`);
        if (!nonEmpty(ev.sku) || !positive(ev.quantity) || !validDate(ev.on) || !nonEmpty(ev.recordedBy)) fail(`${at}: release needs a SKU, a positive quantity, a real date and who recorded it`);
        if (!nonEmpty(ev.fromSnapshotHash) || !nonEmpty(ev.toSnapshotHash)) fail(`${at}: a release must cite the snapshots it was observed between`);
        st.releases.push({ id: ev.id, sku: ev.sku, quantity: ev.quantity, on: ev.on });
        break;
      }
      default: fail(`${at}: unknown event type`);
    }
  });
  return st;
}

export type ClearanceStatus = "NOT_CLEARED" | "PARTIALLY_CLEARED" | "CLEARED" | "NO_BOND_STOCK";
export type BondException = "OVER_RELEASED" | "PROPOSAL_EXCEEDS_ELIGIBLE";
export interface BondAssessment {
  sku: string; inSnapshot: boolean;
  bondPhysical: number; verifiedCleared: number; unverifiedClaimed: number; released: number; remainingCleared: number;
  eligible: number; clearedExceedsBond: boolean; clearanceStatus: ClearanceStatus;
  activeProposed: number; exceptions: BondException[];
  operationalUsable?: number; projectedUsableIfProposedCompleted?: number;
}
export interface AssessContext { bondBySku: ReadonlyMap<string, number>; operationalUsableBySku?: ReadonlyMap<string, number> }

const sumBy = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0);
const clean = (n: number) => (Math.abs(n) < EPS ? 0 : n);

export function assessBond(state: RegisterState, ctx: AssessContext): BondAssessment[] {
  const skus = new Set<string>(ctx.bondBySku.keys());
  for (const s of state.entries.values()) if (!s.withdrawn) s.entry.lines.forEach((l) => skus.add(l.sku));
  state.releases.forEach((r) => skus.add(r.sku));
  for (const p of state.proposals.values()) if (!p.withdrawn) skus.add(p.proposal.sku);
  return [...skus].sort().map((sku) => {
    const lines = [...state.entries.values()].filter((s) => !s.withdrawn).map((s) => ({ s, qty: sumBy(s.entry.lines.filter((l) => l.sku === sku), (l) => l.quantity) })).filter((x) => x.qty > 0);
    const verifiedCleared = sumBy(lines.filter((x) => x.s.verified), (x) => x.qty);
    const unverifiedClaimed = sumBy(lines.filter((x) => !x.s.verified), (x) => x.qty);
    const released = sumBy(state.releases.filter((r) => r.sku === sku), (r) => r.quantity);
    const inSnapshot = ctx.bondBySku.has(sku);
    const bondPhysical = Math.max(0, ctx.bondBySku.get(sku) ?? 0);
    const remainingCleared = clean(Math.max(0, verifiedCleared - released));
    const eligible = clean(Math.min(bondPhysical, remainingCleared));
    const activeProposed = sumBy([...state.proposals.values()].filter((p) => !p.withdrawn && p.proposal.sku === sku), (p) => p.proposal.quantity);
    const exceptions: BondException[] = [];
    if (released - verifiedCleared > EPS) exceptions.push("OVER_RELEASED");
    if (activeProposed - eligible > EPS) exceptions.push("PROPOSAL_EXCEEDS_ELIGIBLE");
    const clearanceStatus: ClearanceStatus = bondPhysical <= EPS ? "NO_BOND_STOCK" : remainingCleared <= EPS ? "NOT_CLEARED" : remainingCleared + EPS >= bondPhysical ? "CLEARED" : "PARTIALLY_CLEARED";
    const row: BondAssessment = { sku, inSnapshot, bondPhysical, verifiedCleared, unverifiedClaimed, released, remainingCleared, eligible, clearedExceedsBond: inSnapshot && remainingCleared - bondPhysical > EPS, clearanceStatus, activeProposed, exceptions };
    const usable = ctx.operationalUsableBySku?.get(sku);
    if (usable !== undefined) { row.operationalUsable = usable; row.projectedUsableIfProposedCompleted = usable + activeProposed; }
    return row;
  });
}

export type ProposalCheck = { ok: true } | { ok: false; reason: string };
/** A new proposal must fit inside what is eligible after the other open proposals. Pure check; creates nothing anywhere. */
export function validateProposal(state: RegisterState, ctx: AssessContext, p: { sku: string; quantity: number; destination: Destination }): ProposalCheck {
  if (!nonEmpty(p.sku) || !positive(p.quantity)) return { ok: false, reason: "a SKU and a positive quantity are required" };
  if (!(DESTINATIONS as readonly string[]).includes(p.destination)) return { ok: false, reason: "the destination must be a non-Bond location role" };
  const row = assessBond(state, ctx).find((r) => r.sku === p.sku);
  if (!row || !row.inSnapshot) return { ok: false, reason: "the SKU has no Bond stock in the snapshot" };
  const available = row.eligible - row.activeProposed;
  if (p.quantity - available > EPS) return { ok: false, reason: `only ${Math.max(0, available)} unit(s) are eligible for release after open proposals (verified clearance and physical Bond stock are the limits)` };
  return { ok: true };
}

export interface MovementSnapshot { bondBySku: ReadonlyMap<string, number>; nonBondBySku: ReadonlyMap<string, number> }
export interface ObservedMovement {
  sku: string; bondDecrease: number; bondIncrease: number; nonBondIncrease: number; eligibleBefore: number;
  /** Bond decrease beyond what was eligible: no verified clearance covers it. Never promoted to cleared. */
  uncleared: number; exceptions: "TRANSFER_WITHOUT_CLEARANCE_EVIDENCE"[];
}
/** Compares two snapshots. `state` must be the register as it stood BEFORE any release for this movement was recorded. Descriptive only. */
export function observeBondMovement(state: RegisterState, prev: MovementSnapshot, curr: MovementSnapshot): ObservedMovement[] {
  const skus = new Set<string>([...prev.bondBySku.keys(), ...curr.bondBySku.keys(), ...prev.nonBondBySku.keys(), ...curr.nonBondBySku.keys()]);
  const before = new Map(assessBond(state, { bondBySku: prev.bondBySku }).map((r) => [r.sku, r.eligible]));
  const out: ObservedMovement[] = [];
  for (const sku of [...skus].sort()) {
    const b0 = prev.bondBySku.get(sku) ?? 0, b1 = curr.bondBySku.get(sku) ?? 0;
    const bondDecrease = clean(Math.max(0, b0 - b1)), bondIncrease = clean(Math.max(0, b1 - b0));
    const nonBondIncrease = clean(Math.max(0, (curr.nonBondBySku.get(sku) ?? 0) - (prev.nonBondBySku.get(sku) ?? 0)));
    if (bondDecrease === 0 && bondIncrease === 0 && nonBondIncrease === 0) continue;
    const eligibleBefore = before.get(sku) ?? 0;
    const uncleared = clean(Math.max(0, bondDecrease - eligibleBefore));
    out.push({ sku, bondDecrease, bondIncrease, nonBondIncrease, eligibleBefore, uncleared, exceptions: uncleared > 0 ? ["TRANSFER_WITHOUT_CLEARANCE_EVIDENCE"] : [] });
  }
  return out;
}

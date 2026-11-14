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
  | { type: "REGISTER_BOUND"; accountIdSha256: string; by: string; on: string }
  | { type: "CLEARANCE_VERIFIED"; entryId: string; verifiedBy: string; verifiedOn: string; documentRef: string; verifiedAt?: string }
  | { type: "CLEARANCE_WITHDRAWN"; entryId: string; by: string; on: string; reason: string }
  | { type: "TRANSFER_PROPOSED"; proposal: TransferProposal }
  | { type: "PROPOSAL_WITHDRAWN"; proposalId: string; by: string; on: string; reason: string }
  | { type: "RELEASE_RECORDED"; id: string; sku: string; quantity: number; on: string; recordedBy: string; fromSnapshotHash: string; toSnapshotHash: string; fromTakenAt: string; toTakenAt: string; proposalId?: string }
  | { type: "RELEASE_VOIDED"; releaseId: string; by: string; on: string; reason: string };

export class BondRegisterError extends Error { constructor(message: string) { super(message); this.name = "BondRegisterError"; } }
const fail = (m: string): never => { throw new BondRegisterError(m); };

const EPS = 1e-9;
const sumBy = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0);
const clean = (n: number) => (Math.abs(n) < EPS ? 0 : n);
function checkMap(name: string, m: ReadonlyMap<string, number> | undefined, allowNegative = false): void {
  if (!m) return;
  for (const v of m.values()) {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name}: every quantity must be a finite number`);
    if (!allowNegative && v < 0) fail(`${name}: every quantity must be non-negative`);
  }
}
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isoTs = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const trim = (s: string) => s.trim();
const refKey = (s: string) => s.trim().toUpperCase();
interface ReleaseState { id: string; sku: string; quantity: number; on: string; fromHash: string; toHash: string; fromTakenAt: string; toTakenAt: string; proposalId?: string; voided: boolean; uncovered: number }
interface EntryState { entry: ClearanceEntry; verified?: { by: string; on: string; at?: string; documentRef: string }; withdrawn?: { by: string; on: string; reason: string } }
export interface RegisterState {
  asOf: string;
  /** SHA-256 of the Cin7 account the register is bound to (REGISTER_BOUND, first event only). Undefined until bound. */
  boundAccount?: string;
  entries: Map<string, EntryState>;
  proposals: Map<string, { proposal: TransferProposal; withdrawn: boolean; completed: number }>;
  releases: ReleaseState[];
}

/** Validates and folds the append-only event list. Throws BondRegisterError (message names the rule, never echoes secrets) on any invalid event. */
export function foldRegister(events: readonly RegisterEvent[], opts: { asOf: string }): RegisterState {
  if (!validDate(opts.asOf)) fail("asOf must be a real YYYY-MM-DD date");
  const st: RegisterState = { asOf: opts.asOf, entries: new Map(), proposals: new Map(), releases: [] };
  const live = (id: string): EntryState => { const e = st.entries.get(typeof id === "string" ? id.trim() : id); if (!e) fail(`unknown clearance entry`); const s = e as EntryState; if (s.withdrawn) fail("the clearance entry is withdrawn"); return s; };
  const notFuture = (d: string, at: string, what: string) => { if (!validDate(d)) fail(`${at}: ${what} must be a real YYYY-MM-DD date`); if (d > opts.asOf) fail(`${at}: ${what} is in the future`); };
  const verifiedFor = (sku: string) => sumBy([...st.entries.values()].filter((s) => !s.withdrawn && s.verified), (s) => sumBy(s.entry.lines.filter((l) => l.sku === sku), (l) => l.quantity));
  events.forEach((ev, i) => {
    const at = `event ${i + 1}`;
    if (ev === null || typeof ev !== "object") fail(`${at}: not a valid register event`);
    switch (ev.type) {
      case "REGISTER_BOUND": {
        if (st.boundAccount !== undefined) fail(`${at}: the register is already bound to an account (it can be bound once)`);
        if (st.proposals.size > 0 || st.releases.length > 0) fail(`${at}: the account must be bound before any transfer proposal or release is recorded`);
        if (!nonEmpty(ev.accountIdSha256) || !nonEmpty(ev.by)) fail(`${at}: the account hash and who bound it are required`);
        notFuture(ev.on, at, "binding date");
        st.boundAccount = trim(ev.accountIdSha256);
        break;
      }
      case "CLEARANCE_ADDED": {
        if (ev.entry === null || typeof ev.entry !== "object") fail(`${at}: clearance entry missing`);
        const e = { ...ev.entry } as ClearanceEntry;
        if (!nonEmpty(e.id)) fail(`${at}: clearance id required`);
        if (st.entries.has(e.id)) fail(`${at}: duplicate clearance id`);
        if (!nonEmpty(e.shipmentRef)) fail(`${at}: shipment or PO reference required`);
        if (!nonEmpty(e.clearanceRef)) fail(`${at}: customs-clearance reference required`);
        if (!validDate(e.clearanceDate)) fail(`${at}: clearance date must be a real YYYY-MM-DD date`);
        if (e.clearanceDate > opts.asOf) fail(`${at}: clearance date is in the future`);
        notFuture(e.recordedOn, at, "recordedOn");
        if (!nonEmpty(e.attributedTo)) fail(`${at}: owner attribution required`);
        if (!(PROVENANCE as readonly string[]).includes(e.provenance)) fail(`${at}: evidence provenance must be one of ${PROVENANCE.join(", ")} (a transfer, posted duty or freight invoice is not clearance evidence)`);
        if (!Array.isArray(e.lines) || e.lines.length === 0) fail(`${at}: at least one SKU line required`);
        const lines: ClearanceLine[] = [];
        const skus = new Set<string>();
        for (const l of e.lines) {
          if (l === null || typeof l !== "object" || !nonEmpty(l.sku)) fail(`${at}: line SKU required`);
          if (!positive(l.quantity)) fail(`${at}: cleared quantity must be a positive number`);
          const sku = trim(l.sku);
          if (skus.has(sku)) fail(`${at}: duplicate SKU within the entry`);
          skus.add(sku); lines.push({ sku, quantity: l.quantity });
        }
        e.id = trim(e.id); e.shipmentRef = trim(e.shipmentRef); e.clearanceRef = trim(e.clearanceRef); e.attributedTo = trim(e.attributedTo); e.lines = lines;
        if (st.entries.has(e.id)) fail(`${at}: duplicate clearance id`);
        for (const other of st.entries.values()) {
          if (other.withdrawn || refKey(other.entry.clearanceRef) !== refKey(e.clearanceRef)) continue;
          if (other.entry.lines.some((l) => skus.has(l.sku))) fail(`${at}: duplicate clearance reference for a SKU already recorded (would count it twice)`);
        }
        st.entries.set(e.id, { entry: e });
        break;
      }
      case "CLEARANCE_VERIFIED": {
        const s = live(ev.entryId);
        if (s.verified) fail(`${at}: the clearance entry is already verified`);
        if (!nonEmpty(ev.verifiedBy)) fail(`${at}: verifier required`);
        notFuture(ev.verifiedOn, at, "verification date");
        if (ev.verifiedOn < s.entry.clearanceDate) fail(`${at}: verification date is before the clearance date`);
        if (!nonEmpty(ev.documentRef)) fail(`${at}: a document reference is required to verify`);
        if (s.entry.provenance === "OWNER_STATEMENT") fail(`${at}: an owner statement alone cannot be verified as customs clearance`);
        if (ev.verifiedAt !== undefined && (!isoTs(ev.verifiedAt) || ev.verifiedAt.slice(0, 10) !== ev.verifiedOn)) fail(`${at}: the verification timestamp must be a real UTC timestamp on the verification date`);
        s.verified = { by: trim(ev.verifiedBy), on: ev.verifiedOn, at: ev.verifiedAt, documentRef: trim(ev.documentRef) };
        break;
      }
      case "CLEARANCE_WITHDRAWN": {
        const s = live(ev.entryId);
        if (!nonEmpty(ev.by) || !nonEmpty(ev.reason)) fail(`${at}: withdrawal needs who and a reason`);
        notFuture(ev.on, at, "withdrawal date");
        s.withdrawn = { by: ev.by, on: ev.on, reason: ev.reason };
        break;
      }
      case "TRANSFER_PROPOSED": {
        if (ev.proposal === null || typeof ev.proposal !== "object") fail(`${at}: proposal missing`);
        const p = { ...ev.proposal };
        if (!nonEmpty(p.id) || st.proposals.has(trim(p.id))) fail(`${at}: proposal id required and unique`);
        if (!nonEmpty(p.sku) || !positive(p.quantity)) fail(`${at}: proposal needs a SKU and a positive quantity`);
        if (!(DESTINATIONS as readonly string[]).includes(p.destination)) fail(`${at}: destination must be a non-Bond location role`);
        if (!nonEmpty(p.proposedBy) || !nonEmpty(p.reason)) fail(`${at}: proposal needs who and a reason`);
        notFuture(p.proposedOn, at, "proposal date");
        p.id = trim(p.id); p.sku = trim(p.sku);
        st.proposals.set(p.id, { proposal: p, withdrawn: false, completed: 0 });
        break;
      }
      case "PROPOSAL_WITHDRAWN": {
        const p = st.proposals.get(typeof ev.proposalId === "string" ? ev.proposalId.trim() : ev.proposalId);
        if (!p) fail(`${at}: unknown proposal`);
        if (!nonEmpty(ev.by) || !nonEmpty(ev.reason)) fail(`${at}: withdrawal needs who and a reason`);
        notFuture(ev.on, at, "withdrawal date");
        (p as { withdrawn: boolean }).withdrawn = true;
        break;
      }
      case "RELEASE_RECORDED": {
        if (!nonEmpty(ev.id) || st.releases.some((r) => r.id === trim(ev.id))) fail(`${at}: release id required and unique`);
        if (!nonEmpty(ev.sku) || !positive(ev.quantity) || !nonEmpty(ev.recordedBy)) fail(`${at}: release needs a SKU, a positive quantity and who recorded it`);
        notFuture(ev.on, at, "release date");
        if (!nonEmpty(ev.fromSnapshotHash) || !nonEmpty(ev.toSnapshotHash)) fail(`${at}: a release must cite the snapshots it was observed between`);
        if (!isoTs(ev.fromTakenAt) || !isoTs(ev.toTakenAt)) fail(`${at}: a release must cite the snapshot timestamps`);
        if (Date.parse(ev.fromTakenAt) >= Date.parse(ev.toTakenAt)) fail(`${at}: the from-snapshot must be before the to-snapshot`);
        if (ev.toTakenAt.slice(0, 10) > opts.asOf) fail(`${at}: snapshot timestamp is in the future`);
        const sku = trim(ev.sku);
        const live = st.releases.filter((r) => r.sku === sku && !r.voided);
        for (const o of live) {
          const same = o.fromHash === ev.fromSnapshotHash && o.toHash === ev.toSnapshotHash;
          if (!same && Date.parse(ev.fromTakenAt) < Date.parse(o.toTakenAt) && Date.parse(ev.toTakenAt) > Date.parse(o.fromTakenAt)) fail(`${at}: this release overlaps the snapshot interval of an earlier release for the same SKU (it would count one movement twice)`);
        }
        if (ev.proposalId !== undefined) {
          const pr = st.proposals.get(trim(ev.proposalId));
          if (!pr) fail(`${at}: unknown proposal`);
          const prop = pr as { proposal: TransferProposal; withdrawn: boolean; completed: number };
          if (prop.proposal.sku !== sku) fail(`${at}: the proposal is for a different SKU`);
          prop.completed += ev.quantity;
        }
        const cover = Math.max(0, verifiedFor(sku) - sumBy(live, (r) => r.quantity));
        st.releases.push({ id: trim(ev.id), sku, quantity: ev.quantity, on: ev.on, fromHash: ev.fromSnapshotHash, toHash: ev.toSnapshotHash, fromTakenAt: ev.fromTakenAt, toTakenAt: ev.toTakenAt, proposalId: ev.proposalId === undefined ? undefined : trim(ev.proposalId), voided: false, uncovered: Math.max(0, ev.quantity - cover) });
        break;
      }
      case "RELEASE_VOIDED": {
        const r = st.releases.find((x) => x.id === (typeof ev.releaseId === "string" ? ev.releaseId.trim() : ev.releaseId));
        if (!r) fail(`${at}: unknown release`);
        const rr = r as ReleaseState;
        if (rr.voided) fail(`${at}: the release is already voided`);
        if (!nonEmpty(ev.by) || !nonEmpty(ev.reason)) fail(`${at}: voiding a release needs who and a reason`);
        notFuture(ev.on, at, "void date");
        rr.voided = true;
        if (rr.proposalId) { const pr = st.proposals.get(rr.proposalId); if (pr) pr.completed = Math.max(0, pr.completed - rr.quantity); }
        break;
      }
      default: fail(`${at}: unknown event type`);
    }
  });
  return st;
}

export type ClearanceStatus = "NOT_CLEARED" | "PARTIALLY_CLEARED" | "CLEARED" | "NO_BOND_STOCK";
export type BondException = "OVER_RELEASED" | "RELEASED_BEFORE_VERIFICATION" | "PROPOSAL_EXCEEDS_ELIGIBLE";
export interface BondAssessment {
  sku: string; inSnapshot: boolean;
  bondPhysical: number; verifiedCleared: number; unverifiedClaimed: number; released: number; releasedBeforeCover: number; remainingCleared: number;
  eligible: number; clearedExceedsBond: boolean; clearanceStatus: ClearanceStatus;
  activeProposed: number; exceptions: BondException[];
  operationalUsable?: number; projectedUsableIfProposedCompleted?: number;
}
export interface AssessContext { bondBySku: ReadonlyMap<string, number>; operationalUsableBySku?: ReadonlyMap<string, number> }


export function assessBond(state: RegisterState, ctx: AssessContext): BondAssessment[] {
  checkMap("bond stock", ctx.bondBySku); checkMap("operational usable", ctx.operationalUsableBySku, true);
  const skus = new Set<string>(ctx.bondBySku.keys());
  for (const s of state.entries.values()) if (!s.withdrawn) s.entry.lines.forEach((l) => skus.add(l.sku));
  state.releases.filter((r) => !r.voided).forEach((r) => skus.add(r.sku));
  for (const p of state.proposals.values()) if (!p.withdrawn && p.proposal.quantity - p.completed > EPS) skus.add(p.proposal.sku);
  return [...skus].sort().map((sku) => {
    const lines = [...state.entries.values()].filter((s) => !s.withdrawn).map((s) => ({ s, qty: sumBy(s.entry.lines.filter((l) => l.sku === sku), (l) => l.quantity) })).filter((x) => x.qty > 0);
    const verifiedCleared = sumBy(lines.filter((x) => x.s.verified), (x) => x.qty);
    const unverifiedClaimed = sumBy(lines.filter((x) => !x.s.verified), (x) => x.qty);
    const liveReleases = state.releases.filter((r) => r.sku === sku && !r.voided);
    const released = sumBy(liveReleases, (r) => r.quantity);
    const releasedBeforeCover = sumBy(liveReleases, (r) => r.uncovered);
    const inSnapshot = ctx.bondBySku.has(sku);
    const bondPhysical = Math.max(0, ctx.bondBySku.get(sku) ?? 0);
    const remainingCleared = clean(Math.max(0, verifiedCleared - released));
    const eligible = clean(Math.min(bondPhysical, remainingCleared));
    const activeProposed = sumBy([...state.proposals.values()].filter((p) => !p.withdrawn && p.proposal.sku === sku), (p) => Math.max(0, p.proposal.quantity - p.completed));
    const exceptions: BondException[] = [];
    if (released - verifiedCleared > EPS) exceptions.push("OVER_RELEASED");
    if (releasedBeforeCover > EPS) exceptions.push("RELEASED_BEFORE_VERIFICATION");
    if (activeProposed - eligible > EPS) exceptions.push("PROPOSAL_EXCEEDS_ELIGIBLE");
    const clearanceStatus: ClearanceStatus = bondPhysical <= EPS ? "NO_BOND_STOCK" : remainingCleared <= EPS ? "NOT_CLEARED" : remainingCleared + EPS >= bondPhysical ? "CLEARED" : "PARTIALLY_CLEARED";
    const row: BondAssessment = { sku, inSnapshot, bondPhysical, verifiedCleared, unverifiedClaimed, released, releasedBeforeCover, remainingCleared, eligible, clearedExceedsBond: inSnapshot && remainingCleared - bondPhysical > EPS, clearanceStatus, activeProposed, exceptions };
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

/**
 * The register as it stood when the movement began (the from-snapshot): a clearance verified AFTER that moment does not cover it, a verification with only a date
 * is judged conservatively (same day = not yet verified), later releases are ignored, and releases recorded for this very pair are never counted against themselves.
 */
function stateAsAt(state: RegisterState, pair: { fromSnapshotHash: string; toSnapshotHash: string; fromTakenAt?: string }): RegisterState {
  const T = pair.fromTakenAt === undefined ? undefined : Date.parse(pair.fromTakenAt);
  if (T !== undefined && Number.isNaN(T)) fail("the from-snapshot timestamp is not a valid timestamp");
  const inForce = (v: NonNullable<EntryState["verified"]>) => (T === undefined ? true : v.at ? Date.parse(v.at) <= T : v.on < new Date(T).toISOString().slice(0, 10));
  const entries = new Map([...state.entries].map(([k, s]) => [k, s.verified && !inForce(s.verified) ? { entry: s.entry, withdrawn: s.withdrawn } : s] as const));
  const releases = state.releases.filter((r) => !(r.fromHash === pair.fromSnapshotHash && r.toHash === pair.toSnapshotHash) && (T === undefined || Date.parse(r.toTakenAt) <= T));
  return { ...state, entries, releases };
}

export interface MovementSnapshot { bondBySku: ReadonlyMap<string, number>; nonBondBySku: ReadonlyMap<string, number> }
export interface ObservedMovement {
  sku: string; bondDecrease: number; bondIncrease: number; nonBondIncrease: number; eligibleBefore: number;
  /** Bond decrease beyond what was eligible: no verified clearance covers it. Never promoted to cleared. */
  uncleared: number; exceptions: "TRANSFER_WITHOUT_CLEARANCE_EVIDENCE"[];
  /** Units of this decrease the register already holds as releases for exactly this snapshot pair (added back to eligibility, never double-counted). */
  alreadyRecorded: number;
}
/**
 * Compares two snapshots. Descriptive only. If the register may already hold releases for THIS snapshot pair, pass their hashes so those releases are
 * excluded from the eligibility the movement is judged against (otherwise a recorded release would be counted against itself).
 */
export function observeBondMovement(state: RegisterState, prev: MovementSnapshot, curr: MovementSnapshot, pair?: { fromSnapshotHash: string; toSnapshotHash: string; fromTakenAt?: string }): ObservedMovement[] {
  for (const m of [prev, curr]) { checkMap("bond stock", m.bondBySku); checkMap("non-Bond stock", m.nonBondBySku); }
  const judged = pair ? stateAsAt(state, pair) : state;
  const skus = new Set<string>([...prev.bondBySku.keys(), ...curr.bondBySku.keys(), ...prev.nonBondBySku.keys(), ...curr.nonBondBySku.keys()]);
  const before = new Map(assessBond(judged, { bondBySku: prev.bondBySku }).map((r) => [r.sku, r.eligible]));
  const out: ObservedMovement[] = [];
  for (const sku of [...skus].sort()) {
    const b0 = prev.bondBySku.get(sku) ?? 0, b1 = curr.bondBySku.get(sku) ?? 0;
    const bondDecrease = clean(Math.max(0, b0 - b1)), bondIncrease = clean(Math.max(0, b1 - b0));
    const nonBondIncrease = clean(Math.max(0, (curr.nonBondBySku.get(sku) ?? 0) - (prev.nonBondBySku.get(sku) ?? 0)));
    if (bondDecrease === 0 && bondIncrease === 0 && nonBondIncrease === 0) continue;
    const eligibleBefore = before.get(sku) ?? 0;
    const uncleared = clean(Math.max(0, bondDecrease - eligibleBefore));
    const alreadyRecorded = pair ? sumBy(state.releases.filter((r) => r.sku === sku && !r.voided && r.fromHash === pair.fromSnapshotHash && r.toHash === pair.toSnapshotHash), (r) => r.quantity) : 0;
    out.push({ sku, bondDecrease, bondIncrease, nonBondIncrease, eligibleBefore, uncleared, exceptions: uncleared > 0 ? ["TRANSFER_WITHOUT_CLEARANCE_EVIDENCE"] : [], alreadyRecorded });
  }
  return out;
}

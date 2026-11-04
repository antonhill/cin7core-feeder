// INTERACTIVE first-run setup + controlled live verification for the DEDICATED RWTSA POC Cin7 instance.
//
//   npx tsx scripts/rwtsa-live/setup.ts
//
// - Prompts for the Account ID and Application Key WITHOUT echo; they never appear in arguments, environment, logs or output.
// - Creates ~/rwtsa-local/credentials (700) with cin7.env, identity.json, locations.json (600); derives the account-identity hash itself.
// - Every network step asks first. GET only, three allowlisted paths, the fixed Cin7 host, fail-closed identity: the same code paths as snapshot.ts.
// - The location mapping is PROPOSED from the real API results (exact names only); anything ambiguous or unmatched is chosen by YOU from a numbered list.
// - Writes a share-safe summary (no secrets, SKUs or quantities) to ~/rwtsa-local/cin7-snapshots/live-verification-<time>.json.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createReadOnlyClient } from "../../src/rwtsa-live/client";
import { collectLocations } from "../../src/rwtsa-live/collect";
import { loadLocationMap, loadRwtsaCredentials } from "../../src/rwtsa-live/credentials";
import { loadIdentityApproval, verifyIdentity } from "../../src/rwtsa-live/identity";
import { createPrompter } from "../../src/rwtsa-live/prompt";
import { runSnapshot } from "../../src/rwtsa-live/run";
import { credentialsDir, proposeLocationMap, recordApprovedFingerprint, writeInitialCredentials, writeLocationMap, type NamedLocation } from "../../src/rwtsa-live/setup-logic";
import { writeSnapshotAtomic, writeTextAtomic } from "../../src/rwtsa-live/store";
import { contractVerdict } from "../../src/rwtsa-live/verdict";
import { ROLES, RwtsaLiveError, type LocationMap, type Role } from "../../src/rwtsa-live/types";
import { runReconcile } from "./reconcile-lib";

const out = (s = "") => process.stdout.write(s + "\n");
const DEFAULT_WORKBOOK = path.join(homedir(), "Downloads", "RWTSA_ERP_Demo_DataSlice_DTCS-RWT-2026-001_FINAL_v2_29Oct2026.xlsx");
const KNOWN = path.join(homedir(), "rwtsa-local", "cin7-snapshots", "known-transactions.json");

async function main(): Promise<number> {
  if (!process.stdin.isTTY) { console.error("Run this in an interactive terminal (it asks for secrets without echo)."); return 2; }
  const home = homedir();
  const dir = credentialsDir(home);
  const p = createPrompter({ input: process.stdin, output: process.stdout });
  const takenAt = new Date().toISOString();
  const report: Record<string, unknown> = { startedAt: takenAt };
  const finish = (code: number) => { p.close(); return code; };

  out("RWTSA POC live verification setup (read-only)");
  out("  - Secrets are typed without echo and stored only in ~/rwtsa-local/credentials (owner-only).");
  out("  - Every Cin7 call is a GET to one of three read-only paths; you are asked before each network step.");
  out("  - Use ONLY the dedicated RWTSA POC instance credentials. Nothing here touches NewQuip or production.\n");

  // ---- 1. credentials ------------------------------------------------------------------------------------------------------------
  let reuse = false;
  if (existsSync(path.join(dir, "cin7.env"))) {
    reuse = await p.confirm("Credentials already exist. Reuse them? [y/N] ");
    if (!reuse && !(await p.confirm("Replace them with new ones? [y/N] "))) { out("Nothing changed."); return finish(0); }
  }
  if (!reuse) {
    const accountId = await p.askHidden("Cin7 Account ID (hidden): ");
    const key = await p.askHidden("Cin7 Application Key (hidden): ");
    const label = (await p.ask("Instance label, non-secret [rwtsa-demo-instance]: ")).trim() || "rwtsa-demo-instance";
    writeInitialCredentials({ home, accountId, applicationKey: key, instanceLabel: label, replace: existsSync(path.join(dir, "cin7.env")) });
    out("Saved. Directory 700, files 600; the account-identity hash was derived automatically.\n");
  }

  // ---- 2. identity preflight (one GET) ---------------------------------------------------------------------------------------------
  if (!(await p.confirm("Make ONE read-only GET of the location list (/ref/location) to establish which account this is? [y/N] "))) { out("Stopped before any network call."); return finish(0); }
  const creds = loadRwtsaCredentials({ home });
  let approval = loadIdentityApproval(dir);
  const client = createReadOnlyClient({ creds });
  const locations = await collectLocations(client);
  const ids = locations.rows.map((r) => String(r.ID ?? "")).filter(Boolean);
  const identity = verifyIdentity({ accountId: creds.accountId, approval, locationIds: ids });
  const named: NamedLocation[] = locations.rows.map((r) => ({ id: String(r.ID ?? ""), name: String(r.Name ?? "") }));
  out(`\nInstance identity (non-secret)\n  account-ID hash : ${identity.accountIdSha256.slice(0, 16)}…\n  locations       : ${identity.locationCount}${locations.complete ? "" : "  (LIST INCOMPLETE: " + locations.problems.join("; ") + ")"}\n  fingerprint     : ${identity.fingerprint}\n  status          : ${identity.status}`);
  named.forEach((l, i) => out(`    ${String(i + 1).padStart(2)}. ${l.name}   ${l.id}`));
  report.identity = { status: identity.status, fingerprint: identity.fingerprint, locationCount: identity.locationCount, accountIdSha256Prefix: identity.accountIdSha256.slice(0, 16), locationListComplete: locations.complete };
  if (!locations.complete || identity.status === "ACCOUNT_MISMATCH" || identity.status === "FINGERPRINT_MISMATCH") {
    out("\nSTOP: identity cannot be established (" + (locations.complete ? identity.status : "incomplete location list") + "). No stock was read.");
    writeTextAtomic({ name: `identity-check-${takenAt.replace(/[:.]/g, "-")}.json`, text: JSON.stringify({ takenAt, identity, locationsComplete: locations.complete, problems: locations.problems, requests: client.requests(), methodsUsed: client.methodsUsed(), stockRead: false }, null, 2) });
    return finish(1);
  }
  if (identity.status === "NOT_APPROVED") {
    const a = await p.ask('\nIf this is the DEDICATED RWTSA POC instance, type APPROVE to record this fingerprint (anything else stops): ');
    if (a.trim() !== "APPROVE") { out("Not approved. Nothing recorded and no stock was read."); return finish(1); }
    recordApprovedFingerprint({ home, fingerprint: identity.fingerprint });
    approval = loadIdentityApproval(dir);
    out("Fingerprint recorded.");
  }

  // ---- 3. location mapping from the real API results ---------------------------------------------------------------------------------
  const proposal = proposeLocationMap(named);
  const chosen: Partial<Record<Role, NamedLocation>> = { ...proposal.proposed };
  const used = new Set(Object.values(chosen).map((l) => l!.id.toLowerCase()));
  for (const r of ROLES) {
    if (chosen[r]) continue;
    out(`\n${r.replace("_", " ")}: ${proposal.ambiguous.includes(r) ? "more than one location matches" : "no exact match"}. Choose it yourself.`);
    for (;;) {
      const n = Number((await p.ask(`  Enter the number of the ${r.replace("_", " ")} location (1-${named.length}), or 0 to stop: `)).trim());
      if (n === 0) { out("Stopped; no mapping written."); return finish(1); }
      const pick = Number.isInteger(n) ? named[n - 1] : undefined;
      if (!pick) { out("  Not a valid number."); continue; }
      if (used.has(pick.id.toLowerCase())) { out("  That location is already assigned to another role."); continue; }
      chosen[r] = pick; used.add(pick.id.toLowerCase()); break;
    }
  }
  out("\nProposed location mapping (identity is by ID):");
  for (const r of ROLES) out(`  ${r.padEnd(14)} ${chosen[r]!.name.padEnd(24)} ${chosen[r]!.id}`);
  if (named.length > ROLES.length) out(`  (${named.length - ROLES.length} other location(s) stay unmapped and are reported, never merged.)`);
  if (!(await p.confirm("Write this mapping to locations.json? [y/N] "))) { out("Not written. Stopped."); return finish(1); }
  const map = Object.fromEntries(ROLES.map((r) => [r, chosen[r]!.id])) as unknown as LocationMap;
  writeLocationMap({ home, map });
  report.bondLocationId = map.BOND;

  // ---- 4. bounded read-only snapshot -----------------------------------------------------------------------------------------------
  if (!(await p.confirm("\nRun the bounded read-only snapshot now (GET: locations, stock availability, products)? [y/N] "))) { out("Stopped before the snapshot. Setup is complete; re-run to continue."); return finish(0); }
  const snapClient = createReadOnlyClient({ creds });
  const result = await runSnapshot({ client: snapClient, creds, locationMap: loadLocationMap(dir), approval, takenAt: new Date().toISOString() });
  if (result.kind === "IDENTITY_FAILED") { out(`STOP: identity check failed on the snapshot run (${result.evidence.identity.status}). No stock was read.`); return finish(1); }
  const snap = result.snapshot;
  const { file: snapFile } = writeSnapshotAtomic({ home, snapshot: snap, creds });
  const verdict = contractVerdict(snap);
  out(`\nSNAPSHOT ${snap.completeness.status} · ${snap.counts.skus} SKUs · ${snap.counts.availabilityRows} stock rows · ${snap.counts.locations} locations · ${snap.counts.products} products · ${snapClient.requests()} GET request(s)`);
  snap.completeness.problems.forEach((x) => out(`  problem: ${x}`));
  out(`\nAPI CONTRACT VERDICT: ${verdict.overall}`);
  verdict.checks.forEach((c) => out(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(26)} ${c.detail}`));
  out(`\nBond location ID: ${snap.locationMapping.bond.id} (${snap.locationMapping.bond.verifiedInLocationList ? "present in the account's location list" : "NOT verified"})`);
  report.snapshotFile = path.basename(snapFile); report.snapshotCompleteness = snap.completeness.status; report.snapshotProblems = snap.completeness.problems; report.counts = snap.counts; report.endpoints = snap.endpoints; report.contractVerdict = verdict; report.fieldTypes = snap.verification.fieldTypes;
  report.stockTotals = { physical: snap.stock.reduce((t, s) => t + s.physical, 0), bond: snap.stock.reduce((t, s) => t + s.bond, 0), unrestricted: snap.stock.reduce((t, s) => t + s.unrestricted, 0), allocatedUnrestricted: snap.stock.reduce((t, s) => t + s.allocatedUnrestricted, 0), usable: snap.stock.reduce((t, s) => t + s.usable, 0), unmapped: snap.stock.reduce((t, s) => t + s.unmapped, 0) };

  // ---- 5. reconciliation (offline) -------------------------------------------------------------------------------------------------
  if (snap.completeness.status === "COMPLETE") {
    const wb = (await p.ask(`\nReconcile offline against the original workbook? Enter its path, or press Enter for the default [${existsSync(DEFAULT_WORKBOOK) ? "found" : "NOT found"}], or "skip": `)).trim();
    if (wb.toLowerCase() !== "skip" && (wb || existsSync(DEFAULT_WORKBOOK))) {
      const r = await runReconcile({ snapshotFile: snapFile, workbookFile: wb || DEFAULT_WORKBOOK, knownFile: existsSync(KNOWN) ? KNOWN : undefined, allowIncomplete: false });
      const s = r.summary;
      out(`RECONCILIATION · ${s.skus} SKUs · match ${s.match} · explained ${s.explained} · unexplained ${s.unexplained} · only in workbook ${s.onlyInWorkbook} · only in Cin7 ${s.onlyInCin7}`);
      out(`  workbook physical ${s.totals.workbookPhysical} vs Cin7 ${s.totals.cin7Physical} · Bond ${s.totals.workbookBond} vs ${s.totals.cin7Bond} · usable ${s.totals.workbookUsable} vs ${s.totals.cin7Usable} · known transactions supplied: ${r.knownCount}`);
      report.reconciliation = { file: path.basename(r.file), summary: s, knownTransactions: r.knownCount };
    }
  } else out("\nReconciliation skipped: the snapshot is not COMPLETE.");

  const { file: rep } = writeTextAtomic({ name: `live-verification-${takenAt.replace(/[:.]/g, "-")}.json`, text: JSON.stringify(report, null, 2) });
  out(`\nShare-safe summary written: ${path.basename(rep)} (in ~/rwtsa-local/cin7-snapshots).`);
  out(`RWTSA PHASE 1 LIVE API: ${verdict.overall}${snap.completeness.status === "COMPLETE" ? "" : " (snapshot INCOMPLETE)"}`);
  return finish(verdict.overall === "PASS" ? 0 : 1);
}

main().then((c) => process.exit(c), (e) => { console.error(e instanceof RwtsaLiveError ? `\nFAILED [${e.code}] ${e.message}` : e instanceof Error && /cancel/i.test(e.message) ? "\nCancelled." : "\nFAILED: unexpected error (details withheld)."); process.exit(1); });

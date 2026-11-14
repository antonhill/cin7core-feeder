// RWTSA (offline, read-only): reconcile ONE native Cin7 CRM Opportunity from a LOCAL export file (CSV text). No network, no Cin7 call of any kind.
// An Opportunity is NOT a sales quotation: its status comes ONLY from the export's own status column and is never run through the quotation status rules.
// Cin7's export headers are not documented in this repo and no real export has been read yet, so columns are matched against explicit candidate lists (or an owner-supplied mapping);
// an unrecognised or ambiguous header makes the affected check UNVERIFIED. The reader never guesses a column.

export type OppField = "number" | "status" | "reference" | "customer" | "rep" | "valueExTax" | "valueInclTax";
export interface OppExpectations { number: string; sourceReference: string; status: string; customer: string; rep: string; valueExTax: number; valueInclTax: number; reason: string }
export type CheckStatus = "PASS" | "FAIL" | "UNVERIFIED";
export interface OppCheck { id: "opportunityPresent" | "nativeStatus" | "sourceReference" | "lossReason" | "customer" | "rep" | "valueExTax" | "valueInclTax"; status: CheckStatus; detail: string }
export interface OppEvidence {
  takenAt: string; rowCount: number; headers: string[];
  columns: Record<OppField, string | null>; columnIssues: string[];
  verdict: "MATCH" | "MISMATCH" | "UNVERIFIED";
  /** Local evidence only: the raw values read from the export row, so the human can see exactly what was compared. */
  observed: { status: string | null; reference: string | null; customer: string | null; rep: string | null; valueExTax: number | null; valueInclTax: number | null } | null;
  checks: OppCheck[];
}

/** Candidate header names per field (compared case/space/punctuation-insensitively). Deliberately conservative: a bare "total" or "value" is ambiguous between ex- and incl-tax and is NOT listed. */
export const CANDIDATES: Record<OppField, readonly string[]> = {
  number: ["opportunity number", "opportunity no", "opportunity id", "opportunity", "number"],
  status: ["status", "opportunity status", "stage"],
  reference: ["reference", "reference number", "opportunity reference"],
  customer: ["customer", "customer name", "contact", "company", "organisation"],
  rep: ["sales representative", "sales rep", "representative", "assigned to", "owner"],
  valueExTax: ["value ex tax", "value excl tax", "value excluding tax", "total before tax", "value ex vat", "value excl vat", "amount ex tax"],
  valueInclTax: ["value incl tax", "value inc tax", "value including tax", "total incl tax", "value incl vat", "value inc vat", "amount incl tax"],
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** "Stock/availability" and "Stock availability" are the same words; punctuation and case are ignored, word content is not. */
const words = (s: string) => key(s);

/** RFC 4180 CSV text to rows (quoted fields, doubled quotes, CRLF). A BOM is stripped. Returns null if a quote is left open. */
export function parseCsv(text: string): string[][] | null {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[][] = []; let row: string[] = []; let f = ""; let q = false; let started = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') { q = true; started = true; } else if (c === ",") { row.push(f); f = ""; started = true; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; if (started || f !== "") { row.push(f); out.push(row); } row = []; f = ""; started = false; }
    else { f += c; started = true; }
  }
  if (q) return null;
  if (started || f !== "") { row.push(f); out.push(row); }
  return out;
}

/** A money value only in an unambiguous form: optional R/ZAR prefix, optional thousands commas (groups of three) or spaces, optional decimals. Anything else is null, never guessed. */
export function parseMoney(raw: string | null): number | null {
  if (raw === null) return null;
  const t = raw.trim().replace(/^(zar|r)\s*/i, "").replace(/\s/g, "");
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function reconcileOpportunity(csvText: string, exp: OppExpectations, opts: { takenAt?: string; mapping?: Partial<Record<OppField, string>> } = {}): OppEvidence {
  const takenAt = opts.takenAt ?? new Date().toISOString();
  const empty: Record<OppField, string | null> = { number: null, status: null, reference: null, customer: null, rep: null, valueExTax: null, valueInclTax: null };
  const fail = (issue: string, headers: string[] = [], rowCount = 0): OppEvidence => ({ takenAt, rowCount, headers, columns: empty, columnIssues: [issue], verdict: "UNVERIFIED", observed: null, checks: [] });
  const table = parseCsv(csvText);
  if (table === null) return fail("The export is not valid CSV (an open quote).");
  if (table.length < 1) return fail("The export is empty.");
  const headers = table[0].map((h) => h.trim());
  if (new Set(headers.map(key)).size !== headers.length) return fail("The export has duplicate or blank column headers; columns cannot be told apart.", headers, table.length - 1);
  const body = table.slice(1);
  if (body.some((r) => r.length !== headers.length)) return fail("A data row has a different number of fields than the header; the export is malformed.", headers, body.length);

  const columns = { ...empty }; const issues: string[] = [];
  for (const f of Object.keys(CANDIDATES) as OppField[]) {
    const mapped = opts.mapping?.[f];
    if (mapped !== undefined) {
      const hit = headers.filter((h) => key(h) === key(mapped));
      if (hit.length === 1) columns[f] = hit[0]; else issues.push(`The mapped header for ${f} was not found exactly once.`);
      continue;
    }
    const hits = headers.filter((h) => CANDIDATES[f].includes(key(h)));
    if (hits.length === 1) columns[f] = hits[0];
    else if (hits.length > 1) issues.push(`More than one header could be the ${f} column (${hits.length}); supply an explicit mapping.`);
  }
  const col = (r: string[], f: OppField): string | null => (columns[f] === null ? null : r[headers.indexOf(columns[f]!)]);
  if (columns.number === null) { issues.push("The Opportunity number column is not recognised."); return { takenAt, rowCount: body.length, headers, columns, columnIssues: issues, verdict: "UNVERIFIED", observed: null, checks: [] }; }

  const rowsHit = body.filter((r) => (col(r, "number") ?? "").trim() === exp.number);
  if (rowsHit.length !== 1) {
    // An export may be filtered or paged, so absence is never proof the Opportunity does not exist.
    const why = rowsHit.length === 0 ? "No row carries that Opportunity number; the export may be filtered or incomplete, so absence cannot be concluded." : "More than one row carries that Opportunity number.";
    return { takenAt, rowCount: body.length, headers, columns, columnIssues: issues, verdict: "UNVERIFIED", observed: null, checks: [{ id: "opportunityPresent", status: "UNVERIFIED", detail: why }] };
  }
  const r = rowsHit[0];
  const status = columns.status ? (col(r, "status") ?? "").trim() : null;
  const reference = columns.reference ? (col(r, "reference") ?? "").trim() : null;
  const customer = columns.customer ? (col(r, "customer") ?? "").trim() : null;
  const rep = columns.rep ? (col(r, "rep") ?? "").trim() : null;
  const ex = columns.valueExTax ? parseMoney(col(r, "valueExTax")) : null;
  const inc = columns.valueInclTax ? parseMoney(col(r, "valueInclTax")) : null;
  const unv = (id: OppCheck["id"], detail: string): OppCheck => ({ id, status: "UNVERIFIED", detail });
  const checks: OppCheck[] = [
    { id: "opportunityPresent", status: "PASS", detail: "Exactly one row carries the Opportunity number." },
    status === null || status === "" ? unv("nativeStatus", "The export has no recognised, non-empty status column.")
      : fold(status) === fold(exp.status) ? { id: "nativeStatus", status: "PASS", detail: `The native Opportunity status is ${status.toUpperCase()}.` }
      : { id: "nativeStatus", status: "FAIL", detail: `The native Opportunity status is "${status}", not ${exp.status}.` },
    reference === null || reference === "" ? unv("sourceReference", "The export has no recognised, non-empty Reference column.")
      : new RegExp(`(^|[^A-Za-z0-9])${exp.sourceReference.replace(/[^A-Za-z0-9]/g, "\\$&")}($|[^A-Za-z0-9])`, "i").test(reference) ? { id: "sourceReference", status: "PASS", detail: "The Reference field contains the source reference." }
      : { id: "sourceReference", status: "FAIL", detail: "The Reference field does not contain the source reference." },
    reference === null || reference === "" ? unv("lossReason", "No Reference text to read a loss reason from.")
      : (` ${words(reference)} `).includes(` ${words(exp.reason)} `) ? { id: "lossReason", status: "PASS", detail: "The Reference field records the expected loss reason (punctuation and case ignored)." }
      : { id: "lossReason", status: "FAIL", detail: "The Reference field does not contain the expected loss reason." },
    customer === null || customer === "" ? unv("customer", "No recognised, non-empty customer column.") : fold(customer) === fold(exp.customer) ? { id: "customer", status: "PASS", detail: "Customer matches." } : { id: "customer", status: "FAIL", detail: "Customer differs from the expected customer." },
    rep === null || rep === "" ? unv("rep", "No recognised, non-empty representative column.") : fold(rep) === fold(exp.rep) ? { id: "rep", status: "PASS", detail: "Representative matches." } : { id: "rep", status: "FAIL", detail: "Representative differs from the expected representative." },
    ex === null ? unv("valueExTax", "No recognised ex-tax value column, or its value is not an unambiguous amount.") : Math.abs(ex - exp.valueExTax) < 0.005 ? { id: "valueExTax", status: "PASS", detail: "Value excluding tax matches." } : { id: "valueExTax", status: "FAIL", detail: `Value excluding tax is ${ex}; expected ${exp.valueExTax}.` },
    inc === null ? unv("valueInclTax", "No recognised incl-tax value column, or its value is not an unambiguous amount.") : Math.abs(inc - exp.valueInclTax) < 0.005 ? { id: "valueInclTax", status: "PASS", detail: "Value including tax matches." } : { id: "valueInclTax", status: "FAIL", detail: `Value including tax is ${inc}; expected ${exp.valueInclTax}.` },
  ];
  const verdict = checks.some((c) => c.status === "FAIL") ? "MISMATCH" : checks.some((c) => c.status === "UNVERIFIED") || issues.length > 0 ? "UNVERIFIED" : "MATCH";
  return { takenAt, rowCount: body.length, headers, columns, columnIssues: issues, verdict, observed: { status, reference, customer, rep, valueExTax: ex, valueInclTax: inc }, checks };
}

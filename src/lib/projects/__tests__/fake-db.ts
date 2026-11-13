// Minimal in-memory stand-in for the supabase-js query builder (service-role client) — just the
// surface project-store.ts uses. Emulates the unique constraints the claim idempotency relies on.
type Row = Record<string, unknown>;
const UNIQUE: Record<string, string[][]> = {
  projects: [["org_id", "project_reference"]],
  project_claims: [["project_id", "claim_seq"], ["org_id", "idempotency_key"], ["org_id", "claim_number"]],
  newquip_quotes: [["org_id", "quote_ref"]],
  project_variations: [["project_id", "code"]],
  project_opening_commitments: [["project_id", "stage_id"]],
  project_cin7_sale_links: [["project_id"], ["org_id", "cin7_sale_id"]],
  project_cin7_sale_creations: [["project_id"], ["org_id", "external_id"]],
  project_variation_stages: [["variation_id", "sort_order"], ["variation_id", "name"]],
  project_deliveries: [["project_id", "label"]],
  project_delivery_allocations: [["delivery_id", "sku"]],
  project_claim_cin7_postings: [["claim_id"], ["org_id", "idempotency_key"], ["org_id", "memo"]],
  newquip_quote_customers: [["quote_id", "seq"]],
  newquip_indicative_price_snapshots: [["quote_id", "seq"]],
  newquip_pricing_revisions: [["quote_id", "seq"]],
  newquip_quote_documents: [["quote_id", "version"], ["storage_path"]],
  newquip_quote_sends: [["document_id", "idempotency_key"]],
  newquip_response_links: [["token_hash"]],
  approval_notifications: [["dedupe_key"]],
  newquip_quote_responses: [["link_id"]],
  newquip_response_reviews: [["response_id"]],
  newquip_response_evidence: [["storage_path"]],
};
/**
 * The REAL columns of the synced-customer tables (migrations 0013 + 0015; contacts live in customer_contacts and `customers` has no contact / email columns). A select,
 * filter or ordering that names any other column fails like PostgREST would (`column customers.contact_name does not exist`), so a test cannot pass on a phantom column.
 */
const REAL_COLUMNS: Record<string, string[]> = {
  customers: ["org_id", "name", "status", "currency", "payment_term", "tax_rule", "account_receivable", "sale_account", "price_tier", "discount", "credit_limit", "carrier", "sales_representative", "location", "tax_number", "tags", "display_name", "is_legal_entity", "parent_customer", "is_bill_parent", "attribute_set", "comments", "updated_at", "content_hash"],
  customer_contacts: ["id", "org_id", "name", "contact_name", "job_title", "phone", "mobile_phone", "fax", "email", "website", "contact_comment", "contact_default", "contact_include_in_email", "marketing_consent"],
};
/** Migration 0115 tables that are append-only (UPDATE and DELETE are refused by their database guards). */
const APPEND_ONLY_0115 = /^(newquip_quote_customers|newquip_quote_documents|newquip_quote_responses|newquip_company_profiles)$/;
/** Migration 0117 tables (response links / reviews / evidence) and the columns it adds to newquip_quote_responses. */
const IS_0117 = /^(newquip_response_links|newquip_response_reviews|newquip_response_evidence)$/;
const COLS_0117 = ["origin", "contact_email", "contact_source", "contact_company", "exception_reason", "authority_confirmed", "document_hash", "link_id", "origin_hint"];
const APPEND_ONLY_0117 = /^(newquip_response_reviews|newquip_response_evidence)$/;
const IS_0115 = /^(newquip_quote_customers|newquip_quote_documents|newquip_quote_sends|newquip_quote_responses|newquip_company_profiles)$/;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  writes: Array<{ table: string; op: string }> = [];
  private clock = 0;
  private seq = 0;

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  private ts(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 15, 0, 0, this.clock)).toISOString();
  }

  /** Records rpc() calls; a test may install a handler to emulate the database function. */
  rpcCalls: Array<{ fn: string; args: Row }> = [];
  rpcHandlers: Record<string, (args: Row) => { error: { message: string } | null }> = {};
  rpc(fn: string, args: Row): Promise<{ data: unknown; error: { message: string } | null }> {
    this.rpcCalls.push({ fn, args });
    if (fn === "newquip_handoff_with_snapshot") return Promise.resolve(this.handoffWithSnapshot(args));
    if (fn === "newquip_apply_pricing_revision") return Promise.resolve(this.applyPricingRevision(args));
    const h = this.rpcHandlers[fn];
    return Promise.resolve({ data: null, error: h ? h(args).error : { message: `no handler for ${fn}` } });
  }

  /** Migration 0123 (indicative price snapshots + the atomic handoff function) is not applied unless a test says so: the function and table then read as absent, like a database that has not received it. */
  indicativeApplied = false;
  /** A test sets this to make the emulated function fail AFTER it would have inserted the snapshot, to prove the whole transaction rolls back (nothing is kept). */
  failHandoffAfterInsert = false;
  /** Emulates newquip_handoff_with_snapshot (migration 0123) as ONE transaction: check, insert the snapshot, move the quotation - or change nothing at all. */
  private handoffWithSnapshot(a: Row): { data: unknown; error: { message: string } | null } {
    if (!this.indicativeApplied) return { data: null, error: { message: "Could not find the function public.newquip_handoff_with_snapshot in the schema cache" } };
    const quotes = this.rows("newquip_quotes");
    const q = quotes.find((r) => r.id === a.p_quote && r.org_id === a.p_org);
    if (!q) return { data: null, error: { message: "handoff_conflict: the quotation was not found" } };
    if (q.state !== "REP_DRAFT" || q.draft_hash !== a.p_draft_hash) return { data: null, error: { message: "handoff_conflict: the quotation changed while sending" } };
    const snaps = this.rows("newquip_indicative_price_snapshots");
    const seq = Math.max(0, ...snaps.filter((r) => r.quote_id === a.p_quote && r.org_id === a.p_org).map((r) => Number(r.seq))) + 1;
    const row: Row = {
      id: `id-${++this.seq}`, created_at: this.ts(), org_id: a.p_org, quote_id: a.p_quote, seq, revision: q.revision, draft_hash: q.draft_hash,
      ruleset_id: a.p_ruleset_id, ruleset_version: a.p_ruleset_version, price_source_id: a.p_price_source_id, price_source_fingerprint: a.p_price_source_fingerprint,
      total_ex_vat_cents: a.p_total_cents, completeness: a.p_completeness, snapshot: structuredClone(a.p_snapshot), snapshot_hash: a.p_snapshot_hash, captured_by_email: a.p_captured_by,
    };
    if (this.failHandoffAfterInsert) return { data: null, error: { message: "simulated failure after the snapshot insert (rolled back)" } };
    snaps.push(row);
    this.writes.push({ table: "newquip_indicative_price_snapshots", op: "insert" });
    Object.assign(q, {
      state: "ESTIMATOR_REVIEW", customer_confirmed_cents: a.p_confirmed_cents, customer_confirmed_by: String(a.p_confirmed_by).trim(), customer_confirmed_at: this.ts(), handoff_by_email: a.p_handoff_by,
      estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    });
    return { data: row.id, error: null };
  }

  /** Migration 0126 (immutable Estimator pricing revisions + the atomic apply function) is not applied unless a test says so. */
  pricingApplied = false;
  /** Emulates newquip_apply_pricing_revision (migration 0126) as ONE transaction: check, insert the revision, write the draft - or change nothing at all. */
  private applyPricingRevision(a: Row): { data: unknown; error: { message: string } | null } {
    if (!this.pricingApplied) return { data: null, error: { message: "Could not find the function public.newquip_apply_pricing_revision in the schema cache" } };
    const q = this.rows("newquip_quotes").find((r) => r.id === a.p_quote && r.org_id === a.p_org);
    if (!q) return { data: null, error: { message: "pricing_conflict: the quotation was not found" } };
    if (q.state !== "REP_DRAFT" && q.state !== "ESTIMATOR_REVIEW") return { data: null, error: { message: "pricing_conflict: the quotation can no longer be edited" } };
    if (q.draft_hash !== a.p_expected_draft_hash) return { data: null, error: { message: "pricing_conflict: the quotation changed while the pricing was being edited" } };
    const revs = this.rows("newquip_pricing_revisions");
    const seq = Math.max(0, ...revs.filter((r) => r.quote_id === a.p_quote && r.org_id === a.p_org).map((r) => Number(r.seq)));
    if (seq !== a.p_expected_seq) return { data: null, error: { message: "pricing_conflict: the pricing changed while it was being edited" } };
    if (String(a.p_reason ?? "").trim().length < 3) return { data: null, error: { message: "check violation: reason" } };
    const row: Row = { id: `id-${++this.seq}`, created_at: this.ts(), org_id: a.p_org, quote_id: a.p_quote, seq: seq + 1, quote_revision: q.revision, kind: a.p_kind, rule_version: a.p_rule_version, reason: a.p_reason,
      previous_pricing: structuredClone(a.p_previous_pricing), new_pricing: structuredClone(a.p_new_pricing), changes: structuredClone(a.p_changes), new_pricing_hash: a.p_new_pricing_hash, draft_hash_after: a.p_new_draft_hash, changed_by_email: a.p_changed_by };
    revs.push(row);
    this.writes.push({ table: "newquip_pricing_revisions", op: "insert" });
    Object.assign(q, { draft: structuredClone(a.p_new_draft), draft_hash: a.p_new_draft_hash, estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null });
    return { data: row.id, error: null };
  }

  /** Emulates PostgREST's max-rows: a select with no .range() silently returns only this many rows (null = unlimited). */
  maxRows: number | null = null;

  /** Migration 0110 (approvals) is not applied unless a test says so: its tables then read as "does not exist", exactly like a database that has not received it. */
  approvalsApplied = false;
  /** Migration 0112 (roles, policies, staged approvals) is not applied unless a test says so. */
  rolesApplied = false;
  /** Migration 0113 (exchange-rate snapshots) is not applied unless a test says so. */
  fxApplied = false;
  /** Migration 0115 (customer snapshots, company profile, issued documents, sends, responses) is not applied unless a test says so. */
  deliveryApplied = false;
  /** Migration 0117 (customer response links, reviews, evidence and the responding-contact columns) is not applied unless a test says so. */
  portalApplied = false;
  /** Statuses the approval_notifications CHECK accepts. Defaults to the 0110 list (no SUPPRESSED, i.e. migration 0114 not applied); a test sets it to include SUPPRESSED. */
  notificationStatuses: string[] = ["PENDING", "SENT", "FAILED", "ABANDONED"];

  from(table: string) {
    const cap = () => this.maxRows;
    const rowsOf = (t: string) => this.rows(t);
    const nextTs = () => this.ts();
    const nextId = () => ++this.seq;
    const writes = this.writes;
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] = [];
    const used: string[] = []; // every column the caller named (select list, filters, ordering)
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let lim: number | null = null;
    let bounds: { from: number; to: number } | null = null;
    let returning = false;

    const setRows = (t: string, rows: Row[]) => { this.tables[t] = rows; };
    const approvals = () => this.approvalsApplied;
    const rolesOn = () => this.rolesApplied;
    const fxOn = () => this.fxApplied;
    const deliveryOn = () => this.deliveryApplied;
    const indicativeOn = () => this.indicativeApplied;
    const portalOn = () => this.portalApplied;
    const notificationStatuses = () => this.notificationStatuses;
    function exec(): { data: unknown; error: { message: string } | null } {
      const real = REAL_COLUMNS[table];
      if (real) for (const c of used) if (!real.includes(c)) return { data: null, error: { message: `column ${table}.${c} does not exist` } };
      if (table === "newquip_fx_rates" && !fxOn()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (IS_0117.test(table) && !portalOn()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (table === "newquip_quote_responses" && !portalOn() && op === "insert") {
        const bad = (Array.isArray(payload) ? payload : [payload]).flatMap((p) => Object.keys(p)).find((k) => COLS_0117.includes(k));
        if (bad) return { data: null, error: { message: `column "${bad}" of relation "newquip_quote_responses" does not exist` } };
      }
      if (table === "newquip_indicative_price_snapshots" && !indicativeOn()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (table === "newquip_indicative_price_snapshots" && (op === "update" || op === "delete")) return { data: null, error: { message: "newquip_indicative_price_snapshots: an indicative snapshot is an audit record and is never updated or deleted" } };
      if (IS_0115.test(table) && !deliveryOn()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (/^(org_functional_role|approval_polic)/.test(table) && !rolesOn()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (table.startsWith("approval_") && !approvals()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (op === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ ...p }));
        const out: Row[] = [];
        for (const r of incoming) {
          for (const cols of UNIQUE[table] ?? []) {
            if (cols.every((c) => r[c] != null) && rowsOf(table).some((e) => cols.every((c) => e[c] === r[c]))) return { data: null, error: { message: `duplicate key value violates unique constraint (${cols.join(",")})` } };
          }
          if (table === "newquip_company_profiles") r.version = Math.max(0, ...rowsOf(table).filter((e) => e.org_id === r.org_id).map((e) => Number(e.version))) + 1;
          const row: Row = { id: `id-${nextId()}`, created_at: nextTs(), ...r };
          rowsOf(table).push(row);
          writes.push({ table, op: "insert" });
          out.push(row);
        }
        return { data: returning ? out : null, error: null };
      }
      let matched = rowsOf(table).filter((r) => filters.every((f) => f(r)));
      if ((op === "update" || op === "delete") && APPEND_ONLY_0117.test(table)) return { data: null, error: { message: `${table}: append-only audit record is never updated or deleted` } };
      if (op === "update" && table === "newquip_response_links") {
        const allowed = new Set(["revoked_at", "revoked_reason", "attempts"]);
        if (Object.keys(payload ?? {}).some((k) => !allowed.has(k))) return { data: null, error: { message: "newquip_response_links: only revocation and the attempt counter may change" } };
        if (matched.some((r) => r.revoked_at && ((payload as Row).revoked_at !== undefined && (payload as Row).revoked_at !== r.revoked_at))) return { data: null, error: { message: "newquip_response_links: a revoked link stays revoked" } };
        if (matched.some((r) => (payload as Row).attempts !== undefined && Number((payload as Row).attempts) < Number(r.attempts ?? 0))) return { data: null, error: { message: "newquip_response_links: the attempt counter never decreases" } };
      }
      if (op === "delete" && table === "newquip_response_links") return { data: null, error: { message: "newquip_response_links: links are never deleted" } };
      if ((op === "update" || op === "delete") && APPEND_ONLY_0115.test(table)) return { data: null, error: { message: `${table}: append-only audit record is never updated or deleted` } };
      if (op === "update" && table === "newquip_quote_sends") {
        const allowed = new Set(["status", "provider_message_id", "last_error", "attempted_at", "suppressed_emails"]);
        if (Object.keys(payload ?? {}).some((k) => !allowed.has(k))) return { data: null, error: { message: "newquip_quote_sends: only the delivery outcome of a send may change" } };
        if (matched.some((r) => (r.status === "ACCEPTED" || r.status === "SUPPRESSED") && (payload as Row).status !== undefined && (payload as Row).status !== r.status)) return { data: null, error: { message: "newquip_quote_sends: a settled send never changes status" } };
      }
      if (op === "delete") {
        const gone = rowsOf(table).filter((r) => filters.every((f) => f(r)));
        setRows(table, rowsOf(table).filter((r) => !gone.includes(r)));
        writes.push({ table, op: "delete" });
        return { data: returning ? gone : null, error: null };
      }
      if (op === "update") {
        const st = (payload as Record<string, unknown> | null)?.status;
        if (table === "approval_notifications" && typeof st === "string" && !notificationStatuses().includes(st)) return { data: null, error: { message: 'new row for relation "approval_notifications" violates check constraint "approval_notifications_status_check"' } };
        for (const r of matched) Object.assign(r, payload);
        writes.push({ table, op: "update" });
        return { data: returning ? matched : null, error: null };
      }
      if (orders.length) {
        const cmp = (x: unknown, y: unknown) => ((x as string) < (y as string) ? -1 : (x as string) > (y as string) ? 1 : 0);
        matched = [...matched].sort((a, b) => { for (const { col, asc } of orders) { const c = cmp(a[col], b[col]); if (c) return c * (asc ? 1 : -1); } return 0; });
      }
      if (lim !== null) matched = matched.slice(0, lim);
      if (bounds) matched = matched.slice(bounds.from, bounds.to + 1);
      else if (cap() !== null) matched = matched.slice(0, cap() as number);
      return { data: matched, error: null };
    }

    const q = {
      select: (cols?: string) => { if (op !== "select") returning = true; if (cols && cols !== "*") used.push(...cols.split(",").map((c) => c.trim()).filter((c) => /^\w+$/.test(c))); return q; },
      insert: (p: Row | Row[]) => { op = "insert"; payload = p; return q; },
      update: (p: Row) => { op = "update"; payload = p; return q; },
      delete: () => { op = "delete"; return q; },
      /** PostgREST upsert on a single conflict column: updates the matching row's given fields, otherwise inserts. */
      upsert: (p: Row, o?: { onConflict?: string }) => {
        const key = o?.onConflict ?? "id";
        const existing = rowsOf(table).find((r) => r[key] === p[key]);
        if (existing) { op = "update"; payload = p; filters.push((r) => r[key] === p[key]); } else { op = "insert"; payload = p; }
        return q;
      },
      // `col->>key` (PostgREST JSON text path) compares the text of that key inside a jsonb column; it is not a column name, so it is not added to `used`.
      eq: (c: string, v: unknown) => {
        const m = /^(\w+)->>(\w+)$/.exec(c);
        if (m) { filters.push((r) => { const j = r[m[1]] as Record<string, unknown> | null; const x = j?.[m[2]]; return x != null && String(x) === String(v); }); return q; }
        used.push(c); filters.push((r) => r[c] === v); return q;
      },
      is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      in: (c: string, v: unknown[]) => { used.push(c); filters.push((r) => v.includes(r[c])); return q; },
      order: (col: string, o?: { ascending?: boolean }) => { used.push(col); orders.push({ col, asc: o?.ascending !== false }); return q; },
      // Supports the `col.ilike.*text*` terms PostgREST's or() takes (a row matches if ANY term matches); `\\` escapes a literal % _ or backslash.
      or: (expr: string) => {
        const terms = expr.split(",").map((t) => { const m = /^(\w+)\.ilike\.\*(.*)\*$/.exec(t); if (!m) throw new Error(`fake-db: unsupported or() term ${t}`); return { col: m[1], needle: m[2].replace(/\\(.)/g, "$1").toLowerCase() }; });
        for (const t of terms) used.push(t.col);
        filters.push((r) => terms.some((t) => String(r[t.col] ?? "").toLowerCase().includes(t.needle)));
        return q;
      },
      range: (from: number, to: number) => { bounds = { from, to }; return q; },
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: () => { const r = exec(); const d = r.data as Row[] | null; return Promise.resolve({ data: d?.[0] ?? null, error: r.error }); },
      single: () => { const r = exec(); const d = r.data as Row[] | null; return Promise.resolve({ data: d?.[0] ?? null, error: r.error ?? (d?.[0] ? null : { message: "no row" }) }); },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  }
}

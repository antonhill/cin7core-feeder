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
    if (fn === "customer_rep_reassign") return Promise.resolve(this.reassignRpc(args));
    if (fn === "newquip_set_rep_isolation") return Promise.resolve(this.setIsolationRpc(args));
    const h = this.rpcHandlers[fn];
    return Promise.resolve({ data: null, error: h ? h(args).error : { message: `no handler for ${fn}` } });
  }

  /**
   * Emulates migration 0118's customer_rep_reassign: ONE all-or-nothing call (the table is restored from a snapshot on ANY error, like a rolled-back transaction), serialised by
   * construction. Same validation, same only-the-intended-assignment scope, same no-duplicate rule, same CHECKs as the SQL function and table.
   */
  private reassignRpc(a: Row): { data: unknown; error: { message: string } | null } {
    if (!this.assignmentsApplied) return { data: null, error: { message: "Could not find the function public.customer_rep_reassign in the schema cache" } };
    const t = "customer_rep_assignments"; const snapshot = this.rows(t).map((r) => ({ ...r })); const clock = () => this.ts();
    const fail = (m: string) => { this.tables[t] = snapshot; return { data: null, error: { message: `customer_rep_reassign: ${m}` } }; };
    const org = a.p_org as string; const customer = String(a.p_customer ?? "").trim(); const reason = String(a.p_reason ?? "").trim();
    if (!org || !a.p_from_user || !a.p_to_user) return fail("the organisation and both Reps are required");
    if (!customer) return fail("choose a customer");
    if (a.p_from_user === a.p_to_user) return fail("choose a different Rep");
    if (reason.length < 3) return fail("give a reason (at least 3 characters)");
    if (!this.rows("org_members").some((m) => m.org_id === org && m.user_id === a.p_to_user)) return fail("the new Rep is not a member of this organisation");
    const rows = this.rows(t);
    const from = rows.find((r) => r.org_id === org && r.cin7_customer_id === customer && r.rep_user_id === a.p_from_user && r.ended_at == null);
    if (!from) return fail("that Rep is not currently assigned to this customer");
    let created = false;
    let next = rows.find((r) => r.org_id === org && r.cin7_customer_id === customer && r.rep_user_id === a.p_to_user && r.ended_at == null);
    if (!next) {
      const email = String(a.p_to_email ?? "").trim().toLowerCase();
      if (email.trim().length <= 3) { this.tables[t] = snapshot; return { data: null, error: { message: 'new row for relation "customer_rep_assignments" violates check constraint "customer_rep_assignments_rep_email_check"' } }; }
      next = { id: `id-${++this.seq}`, created_at: clock(), org_id: org, cin7_customer_id: customer, customer_name: String(a.p_customer_name ?? ""), rep_user_id: a.p_to_user, rep_email: email, assigned_by_email: a.p_actor_email, assigned_by_owner_email: a.p_owner_email ?? null, assigned_reason: reason, assigned_at: clock(), ended_at: null, ended_by_email: null, end_reason: null, replaced_by_assignment_id: null };
      rows.push(next); created = true;
    }
    Object.assign(from, { ended_at: clock(), ended_by_email: a.p_actor_email, end_reason: reason, replaced_by_assignment_id: next.id });   // the ending names the exact successor, in the same call
    this.writes.push({ table: t, op: "rpc:customer_rep_reassign" });
    return { data: { ended: { ...from }, assigned: { ...next }, created }, error: null };
  }

  /** Emulates migration 0119's newquip_set_rep_isolation: validation, then the setting AND its audit event together (nothing is written when validation fails). */
  private setIsolationRpc(a: Row): { data: unknown; error: { message: string } | null } {
    if (!this.accessApplied) return { data: null, error: { message: "Could not find the function public.newquip_set_rep_isolation in the schema cache" } };
    const fail = (m: string) => ({ data: null, error: { message: `newquip_set_rep_isolation: ${m}` } });
    const reason = String(a.p_reason ?? "").trim();
    if (!a.p_org || typeof a.p_enabled !== "boolean") return fail("organisation and desired state are required");
    if (String(a.p_actor_email ?? "").trim().length <= 3) return fail("the actor is required");
    if (reason.length < 5) return fail("give a reason (at least 5 characters)");
    const settings = this.rows("newquip_access_settings"); const cur = settings.find((r) => r.org_id === a.p_org);
    if (cur) Object.assign(cur, { rep_isolation_enabled: a.p_enabled, changed_by_email: a.p_actor_email, changed_at: this.ts(), change_reason: reason });
    else settings.push({ org_id: a.p_org, rep_isolation_enabled: a.p_enabled, changed_by_email: a.p_actor_email, changed_at: this.ts(), change_reason: reason });
    this.rows("newquip_access_setting_events").push({ id: `ev-${++this.seq}`, org_id: a.p_org, enabled: a.p_enabled, actor_email: a.p_actor_email, reason, preflight: a.p_preflight ?? {}, created_at: this.ts() });
    this.writes.push({ table: "newquip_access_settings", op: "rpc:newquip_set_rep_isolation" });
    return { data: a.p_enabled, error: null };
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
  /** Migration 0118 (customer -> Rep assignments) is not applied unless a test says so. */
  assignmentsApplied = false;
  /** Migration 0119 (Rep customer isolation switch) is not applied unless a test says so: its tables then read as "does not exist", exactly like a database that has not received it. */
  accessApplied = false;
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
    const portalOn = () => this.portalApplied;
    const assignmentsOn = () => this.assignmentsApplied;
    const accessOn = () => this.accessApplied;
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
      if ((table === "newquip_access_settings" || table === "newquip_access_setting_events") && !accessOn()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (table === "customer_rep_assignments") {
        // Migration 0118: absent until applied; then the same rules its database guard and partial unique index enforce (append-only history, one ACTIVE row per customer + Rep).
        if (!assignmentsOn()) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
        if (op === "delete") return { data: null, error: { message: "customer_rep_assignments: assignment history is never deleted; end the assignment instead" } };
        if (op === "insert") {
          for (const r of (Array.isArray(payload) ? payload : [payload])) {
            if (r.ended_at != null) return { data: null, error: { message: "customer_rep_assignments: an assignment is created active" } };
            if (String(r.rep_email ?? "").trim().length <= 3) return { data: null, error: { message: 'new row for relation "customer_rep_assignments" violates check constraint "customer_rep_assignments_rep_email_check"' } };
            if (r.cin7_customer_id === "(cleared)" || !String(r.cin7_customer_id ?? "").trim()) return { data: null, error: { message: "new row violates check constraint customer_rep_assignments_cin7_customer_id_check" } };
            if (rowsOf(table).some((e) => e.ended_at == null && e.org_id === r.org_id && e.cin7_customer_id === r.cin7_customer_id && e.rep_user_id === r.rep_user_id)) return { data: null, error: { message: "duplicate key value violates unique constraint customer_rep_assignments_active_uq" } };
          }
        }
        if (op === "update") {
          const p = (payload ?? {}) as Row;
          if (Object.keys(p).some((k) => !["ended_at", "ended_by_email", "end_reason", "replaced_by_assignment_id"].includes(k))) return { data: null, error: { message: "customer_rep_assignments: only ending an assignment may change it" } };
          if (String(p.end_reason ?? "").trim().length < 3 || !p.ended_by_email) return { data: null, error: { message: "new row violates check constraint customer_rep_assignments_check" } };
          if (rowsOf(table).filter((r) => filters.every((f) => f(r))).some((r) => r.ended_at != null)) return { data: null, error: { message: "customer_rep_assignments: an ended assignment never changes" } };
        }
      }
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
      eq: (c: string, v: unknown) => { used.push(c); filters.push((r) => r[c] === v); return q; },
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

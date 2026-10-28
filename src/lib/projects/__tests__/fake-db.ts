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
  project_claim_cin7_postings: [["claim_id"], ["org_id", "idempotency_key"], ["org_id", "memo"]],
};

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
  rpc(fn: string, args: Row): Promise<{ data: null; error: { message: string } | null }> {
    this.rpcCalls.push({ fn, args });
    const h = this.rpcHandlers[fn];
    return Promise.resolve({ data: null, error: h ? h(args).error : { message: `no handler for ${fn}` } });
  }

  from(table: string) {
    const rowsOf = (t: string) => this.rows(t);
    const nextTs = () => this.ts();
    const nextId = () => ++this.seq;
    const writes = this.writes;
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] = [];
    const filters: Array<(r: Row) => boolean> = [];
    let order: { col: string; asc: boolean } | null = null;
    let lim: number | null = null;
    let returning = false;

    const setRows = (t: string, rows: Row[]) => { this.tables[t] = rows; };
    function exec(): { data: unknown; error: { message: string } | null } {
      if (op === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ ...p }));
        const out: Row[] = [];
        for (const r of incoming) {
          for (const cols of UNIQUE[table] ?? []) {
            if (rowsOf(table).some((e) => cols.every((c) => e[c] === r[c]))) return { data: null, error: { message: `duplicate key value violates unique constraint (${cols.join(",")})` } };
          }
          const row: Row = { id: `id-${nextId()}`, created_at: nextTs(), ...r };
          rowsOf(table).push(row);
          writes.push({ table, op: "insert" });
          out.push(row);
        }
        return { data: returning ? out : null, error: null };
      }
      let matched = rowsOf(table).filter((r) => filters.every((f) => f(r)));
      if (op === "delete") {
        const gone = rowsOf(table).filter((r) => filters.every((f) => f(r)));
        setRows(table, rowsOf(table).filter((r) => !gone.includes(r)));
        writes.push({ table, op: "delete" });
        return { data: returning ? gone : null, error: null };
      }
      if (op === "update") {
        for (const r of matched) Object.assign(r, payload);
        writes.push({ table, op: "update" });
        return { data: returning ? matched : null, error: null };
      }
      if (order) {
        const { col, asc } = order;
        matched = [...matched].sort((a, b) => ((a[col] as string) < (b[col] as string) ? -1 : (a[col] as string) > (b[col] as string) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (lim !== null) matched = matched.slice(0, lim);
      return { data: matched, error: null };
    }

    const q = {
      select: () => { if (op !== "select") returning = true; return q; },
      insert: (p: Row | Row[]) => { op = "insert"; payload = p; return q; },
      update: (p: Row) => { op = "update"; payload = p; return q; },
      delete: () => { op = "delete"; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
      order: (col: string, o?: { ascending?: boolean }) => { order = { col, asc: o?.ascending !== false }; return q; },
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: () => { const r = exec(); const d = r.data as Row[] | null; return Promise.resolve({ data: d?.[0] ?? null, error: r.error }); },
      single: () => { const r = exec(); const d = r.data as Row[] | null; return Promise.resolve({ data: d?.[0] ?? null, error: r.error ?? (d?.[0] ? null : { message: "no row" }) }); },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  }
}

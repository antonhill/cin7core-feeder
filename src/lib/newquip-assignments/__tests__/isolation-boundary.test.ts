import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ORG_WIDE_PROJECT_ROLES, ORG_WIDE_QUOTE_ROLES } from "../access";

// STATIC completeness guards for Rep customer isolation (Slice 1B). Behaviour is proven in src/app/newquip-rep/__tests__/rep-isolation.test.ts; these fail the build when someone adds
// a NEW action or route that takes a quotation id (or reads protected rows) and forgets the boundary, or when the TypeScript and SQL role lists drift apart.
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

interface Fn { name: string; params: string; body: string }
/** Top-level functions of a source file (exported or helper), with their parameter list and body text. */
function functions(src: string): Fn[] {
  const out: Fn[] = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)[^{]*\{/gm;
  const starts = [...src.matchAll(re)];
  starts.forEach((m, i) => out.push({ name: m[1], params: m[2], body: src.slice((m.index ?? 0) + m[0].length, i + 1 < starts.length ? starts[i + 1].index : src.length) }));
  return out;
}
const isExportedAsync = (src: string, name: string) => new RegExp(`^export\\s+async\\s+function\\s+${name}\\b`, "m").test(src);

/** Per-file: exported actions with a `quoteId` parameter, minus the justified exemptions. A guard is `guardQuote(` directly, or a same-file helper whose own body calls guardQuote(. */
const ACTION_FILES = [
  "src/app/newquip-grower/actions.ts", "src/app/newquip-grower/customer-actions.ts", "src/app/newquip-grower/document-actions.ts", "src/app/newquip-grower/delivery-actions.ts", "src/app/newquip-grower/mapping-actions.ts", "src/app/newquip-grower/cost-actions.ts",
];
describe("every quotation-scoped server action calls the customer boundary", () => {
  for (const file of ACTION_FILES) {
    it(`${file}: each exported action with a quoteId parameter is guarded (directly or through a guarded helper)`, () => {
      const src = read(file); const fns = functions(src);
      const guardedHelpers = fns.filter((f) => !isExportedAsync(src, f.name) && /guardQuote\(/.test(f.body)).map((f) => f.name);
      const actions = fns.filter((f) => isExportedAsync(src, f.name) && /\bquoteId\b/.test(f.params));
      expect(actions.length, `${file} should have quotation actions`).toBeGreaterThan(0);
      const unguarded = actions.filter((f) => !/guardQuote\(/.test(f.body) && !guardedHelpers.some((h) => new RegExp(`\\b${h}\\(`).test(f.body))).map((f) => f.name);
      expect(unguarded, `unguarded quotation actions in ${file}`).toEqual([]);
    });
  }
  it("the grower workflow `step()` helper (send, return, sign-off, approve) guards, and every action that delegates to it passes its quoteId", () => {
    const src = read("src/app/newquip-grower/actions.ts"); const step = functions(src).find((f) => f.name === "step")!;
    expect(step.body).toMatch(/guardQuote\(/);
    for (const name of ["sendGrowerQuoteToEstimatorAction", "returnGrowerQuoteToRepAction", "signOffGrowerQuoteAction", "returnGrowerQuoteToEstimatorAction", "approveGrowerQuoteAction"]) {
      expect(functions(src).find((f) => f.name === name)!.body, name).toMatch(/return step\(quoteId,/);
    }
  });
  it("the list action filters, and the customer search is restricted for assigned-scoped actors", () => {
    expect(functions(read("src/app/newquip-grower/actions.ts")).find((f) => f.name === "listGrowerQuotesAction")!.body).toMatch(/visibleQuoteIds\([^;]*quoteScope\(/);
    const search = functions(read("src/app/newquip-grower/customer-actions.ts")).find((f) => f.name === "searchQuoteCustomersForQuoteAction")!.body;
    expect(search).toMatch(/quoteScope\(/); expect(search).toMatch(/assignedCustomers\(/);
    expect(read("src/app/newquip-grower/customer-actions.ts")).toMatch(/assertCustomerSelectable\(/);
  });
});

describe("every route handler that serves quotation data calls the boundary BEFORE reading the file", () => {
  const routes: Array<[string, RegExp]> = [
    ["src/app/api/newquip-quote-documents/[id]/route.ts", /guardQuote\([\s\S]*readDocumentBytes\(/],
    ["src/app/api/newquip-response-evidence/[id]/route.ts", /guardQuote\([\s\S]*readEvidenceBytes\(/],
    ["src/app/api/newquip-quote-responses/route.ts", /guardQuote\([\s\S]*req\.formData|guardQuote\([\s\S]*recordStaffResponse\(/],
  ];
  for (const [file, order] of routes) it(`${file}: authorise first, read second`, () => expect(read(file)).toMatch(order));
  it("no other route handler under src/app/api reads NewQuip quotation, document, evidence or response data", () => {
    const dir = join(ROOT, "src", "app", "api");
    const hits: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "route.ts" && /newquip_quote|newquip_response|readDocumentBytes|readEvidenceBytes|loadQuote\(|recordStaffResponse/.test(readFileSync(p, "utf8"))) hits.push(p.replace(ROOT + "/", "")); } };
    walk(dir);
    expect(hits.sort()).toEqual(["src/app/api/newquip-quote-documents/[id]/route.ts", "src/app/api/newquip-quote-responses/route.ts", "src/app/api/newquip-response-evidence/[id]/route.ts"]);
  });
});

describe("approvals and activity", () => {
  const src = read("src/app/approvals/actions.ts"); const fns = functions(src);
  it("every approvals action that takes a request or document id resolves it through the visibility helpers", () => {
    const need = { getApprovalDetailAction: "visibleRequest(", decideApprovalAction: "visibleRequest(", reassignApprovalAction: "visibleRequest(", getDocumentApprovalAction: "visibleDocument(", submitDocumentForApprovalAction: "visibleDocument(" } as const;
    for (const [name, guard] of Object.entries(need)) expect(fns.find((f) => f.name === name)!.body, name).toContain(guard);
    expect(fns.find((f) => f.name === "getApprovalsDashboardAction")!.body).toMatch(/filterApprovalRequests\(/);
    expect(fns.find((f) => f.name === "getMyNotificationsAction")!.body).toMatch(/filterNotifications\(/);
  });
  it("the activity log action filters namespaced entries by scope", () => expect(read("src/app/activity/actions.ts")).toMatch(/quoteScope\([\s\S]*activityVisible\(/));
});

describe("the TypeScript role lists equal the SQL role lists (one rule, two enforcement points)", () => {
  const sql = read("supabase/migrations/0119_newquip_rep_customer_isolation.sql");
  const listIn = (fn: string): string[] => {
    const body = sql.slice(sql.indexOf(`create or replace function ${fn}(`)); const m = body.match(/r\.role in \(([^)]*)\)/)!;
    return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
  };
  it("quotation scope", () => expect(listIn("newquip_quote_scope_ok")).toEqual([...ORG_WIDE_QUOTE_ROLES].sort()));
  it("project scope", () => expect(listIn("newquip_project_scope_ok")).toEqual([...ORG_WIDE_PROJECT_ROLES].sort()));
  it("the SQL activity prefix equals the TypeScript one", () => {
    const m = sql.match(/action !~ '\^\(([^)]*)\)\\\./)!; expect(m[1]).toBe("newquip|approvals|projects");
  });
});

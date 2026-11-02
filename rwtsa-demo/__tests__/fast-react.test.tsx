import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { loadDemoState } from "@/rwtsa-demo/state/demo-state";
import { exchangeSourceFrom } from "@/rwtsa-demo/state/fastreact-model";
import FastReactPage from "../app/fast-react/page";
import { POST } from "../app/api/fast-react/route";
import { GET } from "../app/api/fast-react/download/route";

/** The Fast React exchange page and its routes, in-process, on SYNTHETIC data only. */

let tmp: string;
let stateDir: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-fr-page-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  vi.stubEnv("RWTSA_SOURCE", "synthetic");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
  stateDir = mkdtempSync(join(tmp, "state-"));
  vi.stubEnv("RWTSA_STATE_DIR", stateDir);
});
afterEach(() => vi.unstubAllEnvs());

const SELF = "http://127.0.0.1:3100";
const GOOD = { host: "127.0.0.1:3100", origin: SELF };
const page = async (q: Record<string, string> = {}) => renderToStaticMarkup(await FastReactPage({ searchParams: Promise.resolve(q) }));
const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (m: string) => decode(m.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const attr = (m: string, testid: string, name: string) => [...m.matchAll(new RegExp(`data-testid="${testid}"[^>]*? ${name}="([^"]*)"`, "g"))].map((x) => x[1]);

function send(fields: [string, string | Blob][], headers: Record<string, string> = GOOD, multipart = false) {
  let body: BodyInit;
  const h: Record<string, string> = { ...headers };
  if (multipart) {
    const fd = new FormData();
    for (const [k, v] of fields) fd.append(k, v);
    body = fd;
  } else {
    const u = new URLSearchParams();
    for (const [k, v] of fields) u.append(k, String(v));
    body = u;
  }
  return POST(new Request(`${SELF}/api/fast-react`, { method: "POST", headers: h, body }));
}
const get = (q: string, headers: Record<string, string> = { host: "127.0.0.1:3100" }) => GET(new Request(`${SELF}/api/fast-react/download?${q}`, { headers }));

async function source() {
  const s = await loadDemoState({ source: "synthetic" });
  const ex = exchangeSourceFrom(s);
  if (!ex) throw new Error("no source");
  return ex;
}

/** Supply every planner value for every synthetic order and style. */
async function fillSupplement() {
  const src = await source();
  const customers = [...new Set(src.customers)].sort();
  const fields: [string, string][] = [["action", "supplement-save"]];
  src.orders.forEach((o, i) => {
    fields.push([`customer:${o.orderNo}`, customers[i % customers.length]]);
    fields.push([`date:${o.orderNo}`, `2026-12-${String(4 + i).padStart(2, "0")}`]);
  });
  for (const st of new Set(src.orders.map((o) => o.styleCode))) fields.push([`type:${st}`, "TYPE-" + st.slice(0, 6)]);
  return { src, res: await send(fields) };
}

describe("page content", () => {
  it("states plainly that this is not a live connection and which parts are vendor-documented versus proposed", async () => {
    const t = text(await page());
    expect(t).toContain("NOT A LIVE FAST REACT CONNECTION");
    expect(t).toContain("OUTBOUND: VENDOR-DOCUMENTED FIELDS");
    expect(t).toContain("RETURN: SPARK-PROPOSED");
    expect(t).toContain("SPARK-PROPOSED DEMONSTRATION FORMAT");
    expect(t).toMatch(/not a Fast React specification/i);
    expect(t).toContain("SYNTHETIC");
    expect(t).toMatch(/nothing has been sent to or received from Fast React/i);
  });
  it("shows the five files with the documented names and the vendor field codes", async () => {
    const m = await page();
    for (const n of ["CUSTOMER.txt", "PRODTYPE.txt", "PRODUCTS.txt", "ORDERS.txt", "UPDATE.txt"]) expect(text(m)).toContain(n);
    for (const code of ["C.CODE", "T.CODE", "P.CODE", "P.TYPE", "O.CODE", "O.PROD", "O.CUST", "O^DD:n", "O^DQ:n", "U.ORDER", "U.DATE", "U.QTY"]) expect(m, code).toContain(code);
  });
  it("shows the field-contract matrix with its columns and confidence levels", async () => {
    const m = await page();
    expect(m).toContain('data-testid="matrix"');
    for (const h of ["Source layer", "Source field", "Fast React field", "Required", "Transformation", "Validation", "Evidence", "Confidence"]) expect(text(m)).toContain(h);
    for (const c of ["VERIFIED", "PROPOSED", "UNRESOLVED"]) expect(m).toContain(c);
    expect(text(m)).toContain("Customers.pdf");
  });
  it("states the four ownership statements", async () => {
    const t = text(await page());
    expect(t).toMatch(/CIN7 CORE\s+Products, customers, operational orders and inventory/);
    expect(t).toMatch(/FAST REACT\s+Scheduling and production planning/);
    expect(t).toMatch(/TOOLBOX\s+Exchange generation, validation, reconciliation/);
    expect(t).toMatch(/XERO\s+Financial accounting/);
  });
  it("lists what the vendor must confirm and never claims production readiness", async () => {
    const t = text(await page());
    expect(t).toContain("Before production use, the vendor must confirm");
    expect(t).toMatch(/operation external IDs/i);
    expect(t).not.toMatch(/production[- ]ready|live integration is|connected to Fast React/i);
  });
  it("contains no external URL and no script", async () => {
    const m = await page();
    expect(m).not.toContain("<script");
    expect(m).not.toMatch(/https?:\/\//i);
  });
  it("without planner inputs the order-dependent files FAIL and UPDATE is not exportable, with no download offered", async () => {
    const m = await page();
    expect(attr(m, "file-ORDERS", "data-status")).toEqual(["FAILED"]);
    expect(attr(m, "file-UPDATE", "data-status")).toEqual(["NOT_EXPORTABLE"]);
    expect(m).not.toContain('data-testid="download-ORDERS"');
    expect(text(m)).toContain("BASE FILE SET NOT READY");
  });
});

describe("the whole loop on synthetic data", () => {
  it("planner inputs make the base set ready; files download; the return file previews, applies, and a repeat has no effect", async () => {
    const { res } = await fillSupplement();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("done=supplement-saved");

    const m = await page();
    expect(text(m)).toContain("BASE FILE SET READY AND INTERNALLY CONSISTENT");
    for (const id of ["CUSTOMER", "PRODTYPE", "PRODUCTS", "ORDERS"]) {
      expect(attr(m, `file-${id}`, "data-status")).toEqual(["READY"]);
      const d = await get(`file=${id}`);
      expect(d.status).toBe(200);
      expect(d.headers.get("content-disposition")).toContain(`${id}.txt`);
      expect(d.headers.get("cache-control")).toBe("no-store");
      expect(d.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await d.text();
      expect(body.endsWith("\r\n")).toBe(true);
      expect(body.split("\r\n")[0]).toMatch(/^[A-Z]\.[A-Z]/);
    }
    expect((await get("file=UPDATE")).status).toBe(409);

    // Preview the synthetic sample: nothing applied yet.
    expect((await send([["action", "return-sample"]])).headers.get("location")).toContain("done=return-previewed");
    const preview = await page();
    expect(preview).toContain('data-testid="pending-preview"');
    expect(text(preview)).toContain("PREVIEW: NOT YET APPLIED");
    expect(text(preview)).toContain("SYNTHETIC SAMPLE (SPARK-PROPOSED FORMAT)");
    expect(attr(preview, "plan-outcome", "data-outcome").every((o) => o === "NEW")).toBe(true);
    expect(preview).not.toContain("returned-status-");
    const hash = /name="hash" value="([0-9a-f]{64})"/.exec(preview)![1];

    // Apply.
    expect((await send([["action", "return-apply"], ["hash", hash]])).headers.get("location")).toContain("done=return-applied");
    const applied = await page();
    expect(applied).not.toContain('data-testid="pending-preview"');
    expect(applied).toContain("returned-status-");
    expect(text(applied)).toMatch(/Synthetic sample, Spark-proposed format, applied locally/);
    expect(text(applied)).toContain("Integration status: demonstration, not live");
    expect(text(applied)).toContain("Scenario B production variance is unchanged");
    expect(text(applied)).toContain("no actual labour minutes or material usage");

    // Import the same file again: a duplicate, and nothing changes on disk.
    const file = join(stateDir, readdirSync(stateDir)[0]);
    const before = JSON.stringify(JSON.parse(readFileSync(file, "utf8")).returns);
    await send([["action", "return-sample"]]);
    const again = await page();
    expect(text(again)).toContain("This exact file was already applied");
    expect(attr(again, "plan-outcome", "data-outcome").every((o) => o === "DUPLICATE")).toBe(true);
    expect((await send([["action", "return-apply"], ["hash", hash]])).headers.get("location")).toContain("done=return-nothing-to-apply");
    expect(JSON.stringify(JSON.parse(readFileSync(file, "utf8")).returns)).toBe(before);
  });

  it("an uploaded file is validated; a malformed one is refused and nothing is stored", async () => {
    await fillSupplement();
    const bad = await send([["action", "return-upload"], ["file", new File(["not a return file"], "x.txt", { type: "text/plain" })]], GOOD, true);
    expect(bad.headers.get("location")).toContain("done=return-rejected");
    expect(await page()).not.toContain('data-testid="pending-preview"');
    const sample = await (await get("file=SAMPLE")).text();
    expect(sample).toContain("SPK.ORDER");
    const ok = await send([["action", "return-upload"], ["file", new File([sample], "return.txt", { type: "text/plain" })]], GOOD, true);
    expect(ok.headers.get("location")).toContain("done=return-previewed");
    expect(text(await page())).toContain("SOURCE: LOCAL FILE (SPARK-PROPOSED FORMAT)");
  });

  it("returned progress reaches the order table with source and integration status, and the rehearsal reset clears only the returns", async () => {
    const { src } = await fillSupplement();
    await send([["action", "return-sample"]]);
    const hash = /name="hash" value="([0-9a-f]{64})"/.exec(await page())![1];
    await send([["action", "return-apply"], ["hash", hash]]);
    const m = await page();
    for (const o of src.orders) expect(m).toContain(`data-testid="returned-qty-${o.orderNo}"`);
    await send([["action", "returns-clear"]]);
    const cleared = await page();
    expect(cleared).not.toContain("returned-status-");
    expect(text(cleared)).toContain("BASE FILE SET READY");
  });
});

describe("request safety", () => {
  it("refuses a cross-origin POST and a non-loopback host, changing nothing", async () => {
    expect((await send([["action", "returns-clear"]], { host: "127.0.0.1:3100", origin: "http://127.0.0.1:9" })).status).toBe(403);
    expect((await send([["action", "returns-clear"]], { host: "evil.example", origin: "http://127.0.0.1:9" })).status).toBe(403);
    expect((await send([["action", "returns-clear"]], { host: "127.0.0.1:3100" })).status).toBe(403);
    expect(readdirSync(stateDir)).toEqual([]);
  });
  it("refuses a download addressed to a non-loopback host", async () => {
    expect((await get("file=ORDERS", { host: "evil.example" })).status).toBe(403);
  });
  it("refuses an oversized body with 413 before reading it all", async () => {
    const big = "x".repeat(300 * 1024);
    const r = await send([["action", "return-upload"], ["file", new File([big], "big.txt")]], { ...GOOD }, true);
    expect(r.status).toBe(413);
    const huge = await POST(new Request(`${SELF}/api/fast-react`, { method: "POST", headers: { ...GOOD, "content-length": String(10 * 1024 * 1024), "content-type": "multipart/form-data; boundary=x" }, body: "x" }));
    expect(huge.status).toBe(413);
  });
  it("never takes the redirect target from the request", async () => {
    const r = await send([["action", "bogus"], ["returnTo", "http://127.0.0.1:9/x"]]);
    expect(r.headers.get("location")).toMatch(/^\/fast-react\?done=/);
  });
  it("an unknown or path-like download name is refused without touching the file system", async () => {
    for (const f of ["../../etc/passwd", "ORDERS.txt", "orders", "", "CUSTOMER%00"]) expect([404, 409]).toContain((await get(`file=${f}`)).status);
  });
  it("rejects state-changing requests that name an unknown action", async () => {
    const r = await send([["action", "format-disk"]]);
    expect(r.headers.get("location")).toContain("done=invalid");
  });
});

describe("no data, no substitution", () => {
  it("shows an empty state and offers nothing when no data source is loaded", async () => {
    vi.stubEnv("RWTSA_SOURCE", "");
    const t = text(await page());
    expect(t).toContain("No data source is loaded");
    expect(t).not.toContain("SPK.ORDER");
    expect(t).not.toContain("BASE FILE SET READY");
  });
  it("hashes nothing from, and never touches, files outside the state directory", async () => {
    const before = createHash("sha256").update(readFileSync(new URL("../next.config.ts", import.meta.url))).digest("hex");
    await fillSupplement();
    const after = createHash("sha256").update(readFileSync(new URL("../next.config.ts", import.meta.url))).digest("hex");
    expect(after).toBe(before);
    expect(readdirSync(stateDir).every((f) => /^fastreact-[0-9a-f]{16}\.json$/.test(f))).toBe(true);
  });
});

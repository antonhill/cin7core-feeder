import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-level regression test for the LBL seed migration
 * (0095_seed_lbl_warehouse_performance_scorecard.sql) against the source
 * Excel workbook ("LBL_Warehouse_Review_Scorecard (version 2).xlsb"). This
 * is a transcription-accuracy guard, not a behavioural test — the DB-level
 * behaviour (weight-sum trigger, RLS, immutability) is covered by
 * supabase/tests/0092_warehouse_performance_scorecard.test.sql and was
 * separately verified by applying this exact migration to a live Supabase
 * branch. This test exists specifically because the most likely failure
 * mode here is a silent transcription slip — a target or a reattached
 * comment landing on the wrong KPI — which a SQL syntax check alone would
 * never catch.
 */

const MIGRATION_PATH = join(__dirname, "..", "0095_seed_lbl_warehouse_performance_scorecard.sql");
const fullFile = readFileSync(MIGRATION_PATH, "utf8");
// The file's own leading explanatory comment block mentions several of the
// same workbook phrases (e.g. quoting the reattributed notes) that also
// appear for real inside the SQL data below it — restricting positional
// checks to the executable body (from `do $$` onward) avoids the header
// prose shadowing the actual data's position.
const sql = fullFile.slice(fullFile.indexOf("do $$"));

describe("0095 seed — exactly 33 KPI definitions", () => {
  it("inserts exactly 33 metric_definitions rows", () => {
    // Each row is its own tuple starting "(v_..._id, '<category>', '<name>',"
    // — counting opening tuples keyed to a section-id variable is more
    // robust than counting top-level `insert into` statements (there are
    // six of those, one per section).
    const matches = sql.match(/\(v_\w+_id, '[^']+', '/g) ?? [];
    expect(matches.length).toBe(33);
  });
});

describe("0095 seed — every target matches the workbook exactly", () => {
  const expectedTargets: [name: string, target: string][] = [
    ["Authorised orders moving into picking without unnecessary delay", "Same day / agreed SLA"],
    ["Packed orders waiting for invoicing", "< 1 working day"],
    ["Invoiced orders waiting for dispatch", "< 1 working day"],
    ["Picking accuracy", "≥ 99%"],
    ["Correct SKU, colour, quantity and project picked", "≥ 99%"],
    ["Pickers working from Cin7 rather than emails/manual lists", "100%"],
    ["Packing accuracy", "≥ 99%"],
    ["Boxes clearly labelled with SO, customer and contents", "100%"],
    ["Large/project orders correctly split and identified", "100%"],
    ["Orders dispatched on agreed Ship By date", "≥ 95%"],
    ["Incorrect deliveries / missing boxes", "< 1%"],
    ["Proof of delivery captured correctly", "100%"],
    ["System stock matches physical stock", "≥ 98%"],
    ["Products stored in correct bin locations", "≥ 98%"],
    ["Bin labels clear and consistent", "100%"],
    ["Stock adjustments properly investigated", "100%"],
    ["Backorders identified correctly", "100%"],
    ["Procurement notified through Cin7/system process", "100%"],
    ["Old backorders reviewed regularly", "Weekly"],
    ["Supplier deliveries received into Cin7 promptly", "Same day"],
    ["Quantity and product checked before receipt", "100%"],
    ["Backordered sales orders returned into fulfilment correctly", "100%"],
    ["Pick, Pack and Ship stages used correctly", "≥ 95%"],
    ["Manual emails/workarounds required", "As close to 0 as possible"],
    ["Ship By dates and order information reliable", "≥ 98%"],
    ["Warehouse clean and products easy to locate", "≥ 90%"],
    ["Aisle-Bay-Shelf system followed", "100%"],
    ["Damaged / returns / quarantine stock separated", "100%"],
    ["Staff understand the full warehouse workflow", "100%"],
    ["Staff trained on Cin7", "100%"],
    ["Clear responsibility for picking, packing, receiving and dispatch", "100%"],
    ["Safety incidents", "0"],
    ["Walkways and emergency areas clear", "100%"],
  ];

  it("has exactly 33 expected rows to check (sanity on the test data itself)", () => {
    expect(expectedTargets.length).toBe(33);
  });

  it.each(expectedTargets)("%s -> target %s", (name, target) => {
    const escapedName = name.replace(/'/g, "''");
    // Find this KPI's tuple, then confirm the very next string literal
    // (its target_text) is the expected one — proves the target is
    // attached to the RIGHT kpi, not merely present somewhere in the file.
    const tupleStart = sql.indexOf(`'${escapedName}',`);
    expect(tupleStart, `KPI "${name}" not found in seed`).toBeGreaterThan(-1);
    const afterName = sql.slice(tupleStart + `'${escapedName}',`.length);
    const targetMatch = afterName.match(/^\s*'([^']*)'/);
    expect(targetMatch?.[1] ?? null).toBe(target);
  });
});

describe("0095 seed — Not Scored vs a genuine scored zero stay distinct", () => {
  it("Backorders identified correctly is genuinely Not Scored, never a fabricated score", () => {
    const idx = sql.indexOf("'Backorders identified correctly'");
    const chunk = sql.slice(idx, idx + 600);
    expect(chunk).toMatch(/genuinely Not Scored/i);
    // Must not claim any numeric score for this KPI.
    expect(chunk).not.toMatch(/score \d/i);
  });

  it("Procurement notified through Cin7/system process carries a real scored zero, explicitly distinguished from Not Scored", () => {
    const idx = sql.indexOf("'Procurement notified through Cin7/system process'");
    const chunk = sql.slice(idx, idx + 600);
    expect(chunk).toMatch(/score 0/i);
    expect(chunk).toMatch(/genuine scored zero/i);
    expect(chunk).toMatch(/distinct from the Not Scored/i);
  });
});

describe("0095 seed — spot-check reattributed comments and scores", () => {
  it("Safety incidents keeps its own score (9, Strong) and is not confused with the LOWER_IS_BETTER question that belongs to Manual emails/workarounds", () => {
    const idx = sql.indexOf("'Safety incidents'");
    const chunk = sql.slice(idx, idx + 700);
    expect(chunk).toMatch(/score 9, status Strong/i);
    expect(chunk).toMatch(/LOWER_IS_BETTER/);
  });

  it("Manual emails/workarounds required carries the workbook's own 'is 0 good or bad' question, not Safety incidents", () => {
    const idx = sql.indexOf("'Manual emails/workarounds required'");
    const chunk = sql.slice(idx, idx + 700);
    expect(chunk).toMatch(/is ''0'' good or bad/i);
    expect(chunk).toMatch(/score 3, status Serious Weakness/i);
  });

  it("the 'Anton - reporting' and 'Auth per day' notes are attached to Order Flow KPIs 1 and 3, not Cin7 Compliance", () => {
    const authNoteIdx = sql.indexOf("Report - indicating number of Auth per day");
    const antonNoteIdx = sql.indexOf("Anton - reporting");
    expect(authNoteIdx).toBeGreaterThan(-1);
    expect(antonNoteIdx).toBeGreaterThan(-1);

    const orderFlow1 = sql.indexOf("'Authorised orders moving into picking without unnecessary delay'");
    const orderFlow3 = sql.indexOf("'Invoiced orders waiting for dispatch'");
    const cin7Compliance1 = sql.indexOf("'Pick, Pack and Ship stages used correctly'");

    expect(authNoteIdx).toBeGreaterThan(orderFlow1);
    expect(authNoteIdx).toBeLessThan(orderFlow3);
    expect(antonNoteIdx).toBeGreaterThan(orderFlow3);
    // Neither note should appear anywhere near the Cin7 Compliance section's first KPI.
    expect(sql.slice(cin7Compliance1, cin7Compliance1 + 700)).not.toMatch(/Auth per day|Anton - reporting/);
  });
});

describe("0095 seed — headline weights still sum to 1.0", () => {
  it("the six section weights are exactly 0.20/0.20/0.20/0.15/0.15/0.10", () => {
    const weights = [...sql.matchAll(/\(v_def_id, '[^']+', (0\.\d+), \d+\)/g)].map((m) => Number(m[1]));
    expect(weights).toEqual([0.2, 0.2, 0.2, 0.15, 0.15, 0.1]);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 10);
  });
});

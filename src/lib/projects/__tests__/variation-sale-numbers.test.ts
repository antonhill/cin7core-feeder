import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { loadSaleNumbersByProject, saleNumbersByVariation } from "../variation-billing-store";

// Read-only lookup of the Cin7 Sale number ALREADY STORED against each billing project: no Cin7 call, no write, org-scoped, never inferred.
const link = (org: string, project: string, num: string | null) => ({ org_id: org, project_id: project, cin7_sale_id: `sale-${project}`, cin7_sale_number: num });
function db(rows: Array<ReturnType<typeof link>>) { const d = new FakeDb(); d.rows("project_cin7_sale_links").push(...rows); return d; }

describe("loadSaleNumbersByProject", () => {
  it("returns the stored number for each linked project", async () => {
    const d = db([link("org-a", "vp1", "SO-1001"), link("org-a", "vp2", "SO-1002")]);
    expect(await loadSaleNumbersByProject(d as never, "org-a", ["vp1", "vp2"])).toEqual({ vp1: "SO-1001", vp2: "SO-1002" });
  });
  it("omits a project with no link, and a link with no stored number: nothing is invented", async () => {
    const d = db([link("org-a", "vp2", null)]);
    expect(await loadSaleNumbersByProject(d as never, "org-a", ["vp1", "vp2"])).toEqual({});
  });
  it("reads only the projects asked for: the BASE project's Sale is not returned for a variation lookup", async () => {
    const d = db([link("org-a", "base", "SO-BASE"), link("org-a", "vp1", "SO-V1")]);
    expect(await loadSaleNumbersByProject(d as never, "org-a", ["vp1"])).toEqual({ vp1: "SO-V1" });
  });
  it("never returns another organisation's Sale, even for the same project id", async () => {
    const d = db([link("org-b", "vp1", "SO-OTHER-ORG")]);
    expect(await loadSaleNumbersByProject(d as never, "org-a", ["vp1"])).toEqual({});
  });
  it("makes no read at all for an empty list, and no write ever", async () => {
    const d = db([link("org-a", "vp1", "SO-1")]);
    expect(await loadSaleNumbersByProject(d as never, "org-a", [])).toEqual({});
    await loadSaleNumbersByProject(d as never, "org-a", ["vp1"]);
    expect(d.writes).toEqual([]);
  });
});

describe("saleNumbersByVariation", () => {
  it("joins each variation to ITS OWN billing project's number, never another's", () => {
    expect(saleNumbersByVariation({ v1: "vp1", v2: "vp2", v3: "vp3" }, { vp1: "SO-1", vp2: "SO-2" })).toEqual({ v1: "SO-1", v2: "SO-2" });
    expect(saleNumbersByVariation({ v1: "vp1", v2: "vp2" }, { vp1: "SO-2", vp2: "SO-1" })).toEqual({ v1: "SO-2", v2: "SO-1" });
  });
  it("ignores numbers of projects that are not a variation's billing project (e.g. the base project)", () => {
    expect(saleNumbersByVariation({ v1: "vp1" }, { base: "SO-BASE" })).toEqual({});
  });
});

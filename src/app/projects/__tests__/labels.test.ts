import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Terminology guard: "remaining" is contract − invoiced/committed, NOT contract − earned. The label must say so,
// everywhere the metric appears, and the three progress concepts must stay separate in the UI.
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const detail = read("[id]/ProjectWorkspace.tsx");
const list = read("page.tsx");

describe("Projects terminology", () => {
  it("uses 'Remaining to bill / commit' for the remaining metric on the overview, stages table and list", () => {
    expect(detail.match(/Remaining to bill \/ commit/g)?.length).toBe(2);
    expect(list.match(/Remaining to bill \/ commit/g)?.length).toBe(1);
  });
  it("no longer uses the ambiguous labels", () => {
    expect(detail).not.toContain("Remaining contract value");
    expect(detail).not.toMatch(/<TH align="right">Remaining<\/TH>/);
    expect(list).not.toMatch(/<TH align="right">Remaining<\/TH>/);
  });
  it("keeps physical, commercial and billed as separate concepts and never says 'claim sent'", () => {
    expect(detail).toContain("Physical progress");
    expect(detail).toContain("Commercial approval");
    expect(detail).toContain("Billed / committed");
    expect(detail).toContain("Not sent to Cin7");
    expect(detail).not.toMatch(/Send to Cin7|Create Cin7 invoice|Authorise invoice/i);
  });
  it("physical and commercial progress are separate actions; physical never sends an approved value", () => {
    expect(detail).toContain("Record physical progress");
    expect(detail).toContain("Approve commercial progress");
    expect(detail).toMatch(/recordProgressAction\(id, s\.id, reported, null, comment\)/);
  });
  it("privileged controls wait for a resolved permission (loading | member | admin) and fail closed", () => {
    expect(detail).toContain('type ViewerPermission = "loading" | "member" | "admin"');
    expect(detail).toContain('useState<ViewerPermission>("loading")');
    expect(detail).toContain('r.ok && r.data?.canApprove ? "admin" : "member"');
    expect(detail).toContain('perm === "admin"');
    expect(detail).toContain('perm === "member"');
    expect(detail).not.toContain("canApprove}"); // no boolean default that could flash admin controls
    expect(list).toContain("useState<boolean | null>(null)");
    expect(list).toContain("canAdmin === true");
  });
  it("progress forms clear only after a confirmed save", () => {
    expect(detail).toMatch(/if \(await save\) \{\s*setComment\(""\)/);
    expect(detail).toContain("Resolves true only when the action succeeded");
  });
});

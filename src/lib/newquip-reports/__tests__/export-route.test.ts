import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const session = vi.fn(); const exp = vi.fn(async () => ({ buffer: Buffer.from("x"), fileName: "f.xlsx" }));
vi.mock("../session", () => ({ reportSession: () => session() }));
vi.mock("../service", async (orig) => ({ ...(await orig<typeof import("../service")>()), exportReport: (...a: unknown[]) => exp(...(a as [])) }));
import { GET } from "@/app/newquip-grower/reports/export/[kind]/route";

const call = (kind: string) => GET(new Request(`http://x/newquip-grower/reports/export/${kind}?from=2026-11-01`), { params: Promise.resolve({ kind }) });
const v = (roles: string[], canSeeCost: boolean) => ({ db: {}, viewer: { orgId: "o", email: "e", roles: new Set(roles), canSeeCost } });
beforeEach(() => { session.mockReset(); exp.mockClear(); });

describe("export authorisation", () => {
  it("unknown report 404; unauthenticated 403 and nothing is built", async () => {
    expect((await call("nope")).status).toBe(404);
    session.mockRejectedValueOnce(new Error("no")); expect((await call("pipeline")).status).toBe(403); expect(exp).not.toHaveBeenCalled();
  });
  it("a Rep cannot export costing or the management overview", async () => {
    session.mockResolvedValue(v(["rep"], false));
    expect((await call("costing")).status).toBe(403); expect((await call("overview")).status).toBe(403); expect(exp).not.toHaveBeenCalled();
    expect((await call("pipeline")).status).toBe(200);
  });
  it("an Estimator may export costing, a Manager everything; responses are private, no-store xlsx", async () => {
    session.mockResolvedValue(v(["estimator"], true)); const r = await call("costing");
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toMatch(/no-store/); expect(r.headers.get("content-type")).toMatch(/spreadsheetml/);
    session.mockResolvedValue(v(["manager"], true)); expect((await call("overview")).status).toBe(200);
  });
});

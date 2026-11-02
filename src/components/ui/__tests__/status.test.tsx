// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScopeTag, Status, statusText } from "../Status";

afterEach(cleanup);

// Tailwind v4 default palette values for the classes Status uses.
const HEX: Record<string, string> = {
  "slate-100": "#f1f5f9", "slate-700": "#334155", "indigo-50": "#eef2ff", "indigo-800": "#3730a3", "emerald-50": "#ecfdf5", "emerald-800": "#065f46",
  "amber-50": "#fffbeb", "amber-900": "#78350f", "red-50": "#fef2f2", "red-800": "#991b1b", "sky-50": "#f0f9ff", "sky-800": "#075985",
};
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

describe("Status", () => {
  it.each(["neutral", "primary", "success", "warning", "danger", "info"] as const)("%s text is at least 4.5:1 on its own tint, and carries a non-colour mark", (tone) => {
    render(<Status tone={tone}>Label</Status>);
    const el = screen.getByText("Label");
    const bg = /bg-([a-z]+-\d+)/.exec(el.className)![1];
    const fg = /text-([a-z]+-\d+)/.exec(el.className)![1];
    expect(contrast(HEX[fg], HEX[bg])).toBeGreaterThanOrEqual(4.5);
    expect(el.querySelector("[aria-hidden]")?.textContent).toMatch(/\S/);
  });
  it("uses a different mark for each meaning that differs from neutral", () => {
    const marks = new Set<string>();
    for (const tone of ["success", "warning", "danger", "info"] as const) {
      const { container } = render(<Status tone={tone}>x</Status>);
      marks.add(container.querySelector("[aria-hidden]")!.textContent!);
      cleanup();
    }
    expect(marks.size).toBe(4);
  });
  it("ScopeTag names BASE and VARIATION the same way everywhere", () => {
    render(<><ScopeTag scope="BASE" /><ScopeTag scope="VARIATION" /></>);
    expect(screen.getByText("Base")).toBeTruthy();
    expect(screen.getByText("Variation")).toBeTruthy();
  });
  it("statusText gives sentence-case wording", () => {
    expect(statusText("READY_FOR_APPROVAL")).toBe("Ready for approval");
    expect(statusText("CIN7_CREATED")).toBe("Cin7 created");
    expect(statusText("ACTIVE")).toBe("Active");
    expect(statusText("FAILED_CONFIRMED_NO_WRITE")).toBe("Failed confirmed no write");
  });
});

function sources(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "__tests__") sources(p, out); } else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("NewQuip design foundations stay in place", () => {
  const root = join(__dirname, "..", "..", "..", "app");
  const files = ["projects", "approvals", "newquip-grower"].flatMap((d) => sources(join(root, d)));
  it("no NewQuip surface uses the low-contrast slate-500 caption, the 11px size, or the generic Badge for a domain state", () => {
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      expect(s.includes("text-slate-500"), `${f} text-slate-500`).toBe(false);
      expect(s.includes("text-[11px]"), `${f} text-[11px]`).toBe(false);
      expect(/ui\/Badge"/.test(s) && /<Badge[ >]/.test(s), `${f} uses Badge`).toBe(false);
    }
  });
  it("every NewQuip page header uses the workspace variant", () => {
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/<ModuleHeader (?!variant="workspace")/g)) throw new Error(`${f}: ${m[0]}`);
  });
});

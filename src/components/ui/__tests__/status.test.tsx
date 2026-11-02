// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScopeTag, Status, statusText } from "../Status";

afterEach(cleanup);

// The real Tailwind v4 palette (oklch) read from the installed package, so the ratios are measured on what ships.
const theme = readFileSync(join(__dirname, "..", "..", "..", "..", "node_modules", "tailwindcss", "theme.css"), "utf8");
function oklchToHex(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(theme);
  if (!m) throw new Error(`colour ${name} not in the Tailwind theme`);
  const [L, C, h] = [Number(m[1]) / 100, Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss];
  const enc = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  return "#" + lin.map((v) => enc(v).toString(16).padStart(2, "0")).join("");
}
const HEX = new Proxy({} as Record<string, string>, { get: (_t, name: string) => oklchToHex(name) });
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
  it("the neutral and the old Badge success tone were measured, so the guard has teeth: emerald-600 on emerald-50 fails 4.5:1", () => {
    expect(contrast(HEX["emerald-600"], HEX["emerald-50"])).toBeLessThan(4.5);
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
    expect(statusText("FAILED_CONFIRMED_NO_WRITE")).toBe("Failed, nothing written");
    expect(statusText("FAILED_UNCERTAIN")).toBe("Outcome uncertain");
    expect(statusText("CANCELLED_BEFORE_WRITE")).toBe("Cancelled");
    expect(statusText("CIN7_PENDING")).toBe("Awaiting Cin7 result");
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
  it("no NewQuip surface uses slate-400 for text", () => {
    for (const f of files) expect(readFileSync(f, "utf8").includes("text-slate-400"), f).toBe(false);
  });
  it("every NewQuip page header uses the workspace variant (wherever the prop sits, across lines too)", () => {
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/<ModuleHeader\b[^>]*>/g)) expect(m[0], f).toMatch(/variant="workspace"/);
  });
});

#!/usr/bin/env node
// UX-004 browser-level check: the DOCUMENT must not be taller than the viewport when the app scrolls inside its own container.
// Extra document height means something escaped the scroll container's clip (typically an absolutely positioned element with no positioned
// ancestor, e.g. an `sr-only` label) and shows as a blank band of several screens under the last panel.
//
//   node scripts/check-scroll-height.mjs <url | file.html> [--css compiled.css] [--chrome /path/to/chrome]
//
// A URL needs a signed-in session to show app pages, so for authenticated pages use a saved DOM dump plus the compiled CSS
// (.next/static/chunks/*.css). Needs `playwright-core` (not a repo dependency: `npm i --no-save playwright-core`) and a local Chrome.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
if (!target) { console.error("usage: check-scroll-height.mjs <url|file.html> [--css file|dir] [--chrome path]"); process.exit(2); }

let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core")); } catch { console.error("playwright-core is not installed (npm i --no-save playwright-core)"); process.exit(2); }
const chrome = opt("chrome") ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
const cssArg = opt("css");
const css = cssArg ? (readdirSync(cssArg, { withFileTypes: true }).length ? readdirSync(cssArg).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(cssArg, f), "utf8")).join("\n") : "") : "";

const browser = await chromium.launch({ executablePath: chrome, headless: true });
let failed = false;
for (const [w, h] of [[1920, 1080], [1440, 900], [820, 1180], [390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  if (/^https?:/.test(target)) await page.goto(target, { waitUntil: "networkidle" });
  else await page.setContent(`<!doctype html><html lang="en" class="h-full antialiased"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="flex h-full min-h-screen flex-col md:flex-row">${readFileSync(target, "utf8")}</body></html>`);
  const r = await page.evaluate(() => {
    const extra = document.documentElement.scrollHeight - innerHeight;
    const escapees = [...document.querySelectorAll("body *")].filter((e) => getComputedStyle(e).position === "absolute" && e.offsetParent === document.body || (getComputedStyle(e).position === "absolute" && e.offsetParent === null));
    return { extra, escapees: escapees.slice(0, 5).map((e) => `${e.tagName}.${String(e.getAttribute("class")).slice(0, 40)} "${(e.textContent || "").slice(0, 20)}"`) };
  });
  const ok = r.extra <= 1;
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${w}px: document is ${r.extra}px taller than the viewport${ok ? "" : `; escaping: ${r.escapees.join(" | ")}`}`);
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);

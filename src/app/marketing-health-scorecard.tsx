"use client";

import { useEffect, useRef, useState, useTransition } from "react";

type Tone = "red" | "amber" | "green";

const TONE_DOT: Record<Tone, string> = {
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-emerald-400",
};

/**
 * Decorative demo data only (this page has no live org to score) — but the
 * bands, dimension labels/order, and flagged/scanned format are all pulled
 * from the real feature (src/health/system-health.ts, src/app/health/page.tsx)
 * so this can't misrepresent how System Health actually works. Overall
 * score is computed with the same unweighted-mean formula the real feature
 * uses, not hardcoded, so it can't drift out of sync with these counts.
 */
const DIMENSIONS: { label: string; tone: Tone; flagged: number; scanned: number }[] = [
  { label: "Sales unfulfilled past deadline", tone: "red", flagged: 180, scanned: 512 },
  { label: "Purchases not received past deadline", tone: "red", flagged: 60, scanned: 240 },
  { label: "Transfers stuck", tone: "green", flagged: 0, scanned: 88 },
  { label: "Assemblies not completed", tone: "red", flagged: 170, scanned: 310 },
  { label: "Production Orders due and behind", tone: "green", flagged: 0, scanned: 45 },
  { label: "Product data health", tone: "red", flagged: 2560, scanned: 3410 },
];

const OVERALL_SCORE = Math.round(
  100 * (1 - DIMENSIONS.reduce((sum, d) => sum + (d.scanned > 0 ? d.flagged / d.scanned : 0), 0) / DIMENSIONS.length)
);
const NEEDS_ATTENTION = DIMENSIONS.filter((d) => d.tone !== "green").length;

/** The hero's signature element — a live-looking System Health scorecard that counts up to the real (>90 healthy / >=70 amber / <70 red, per src/app/health/page.tsx) "at risk" band. */
export default function HealthScorecard() {
  const ref = useRef<HTMLDivElement>(null);
  const [score, setScore] = useState(0);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      startTransition(() => setScore(OVERALL_SCORE));
      return;
    }
    let started = false;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting && !started) {
            started = true;
            let v = 0;
            const step = () => {
              v += Math.max(1, Math.round((OVERALL_SCORE - v) / 6));
              if (v >= OVERALL_SCORE) v = OVERALL_SCORE;
              setScore(v);
              if (v < OVERALL_SCORE) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }
        });
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="rounded-2xl border border-sidebar-border bg-sidebar-bg-raised p-6 shadow-2xl">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-sidebar-text">System Health</p>
          <p className="mt-1 font-mono text-sm text-white">acme-trading</p>
        </div>
        <span className="rounded-md border border-red-500/30 bg-red-500/15 px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-red-400">
          At risk
        </span>
      </div>

      <div className="mt-5 flex items-center gap-5">
        <div
          className="relative grid h-28 w-28 shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(#ef4444 ${score}%, #2b3252 0)` }}
        >
          <div className="absolute inset-2.5 rounded-full bg-sidebar-bg-raised" />
          <span className="relative text-4xl font-bold text-white">{score}</span>
          <span className="relative -mt-1 font-mono text-xs text-sidebar-text">/ 100</span>
        </div>
        <div className="text-sm text-sidebar-text">
          <p>
            <strong className="font-semibold text-white">{DIMENSIONS.length} dimensions</strong> scanned
          </p>
          <p>
            <strong className="font-semibold text-white">{NEEDS_ATTENTION} need</strong> attention
          </p>
          <p>
            Scanned <strong className="font-semibold text-white">just now</strong>
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2.5 border-t border-sidebar-border pt-4">
        {DIMENSIONS.map((d) => (
          <div key={d.label} className="flex items-center gap-3 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[d.tone]}`} />
            <span className="flex-1 text-slate-200">{d.label}</span>
            <span className="font-mono text-xs text-sidebar-text">
              {d.flagged.toLocaleString()} / {d.scanned.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

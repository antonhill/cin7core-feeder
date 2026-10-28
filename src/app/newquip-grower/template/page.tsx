import Link from "next/link";
import { redirect } from "next/navigation";
import { ModuleHeader } from "@/app/ModuleHeader";
import { QUOTES_MODULE } from "@/app/module-nav";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { GROWER_RULESET_VERSION } from "@/newquip/grower/final-feedback";
import { growerTemplateSections, TEMPLATE_HEADER, TREATMENT_LABEL } from "@/newquip/grower/template";
import { POC_ITEM_REGISTER } from "@/newquip/grower/open-items";

// Grower House Template v1 — READ-ONLY detail. Derived from the live rule table, so it cannot drift from what the engine does.
// This is deliberately not the Rules & Templates editor: there is nothing to change here.

export default async function GrowerTemplatePage() {
  try {
    await requireNewquipPocOrg();
  } catch {
    redirect("/");
  }
  const sections = growerTemplateSections();
  return (
    <main className="mx-auto w-full max-w-[1480px] px-6 py-12">
      <ModuleHeader module={QUOTES_MODULE}>
        <Link href="/newquip-grower" className="text-indigo-700 hover:underline">← Grower quotes</Link> · Template detail
      </ModuleHeader>

      <Panel className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{TEMPLATE_HEADER.name}</h1>
          <Badge tone="neutral">Version {TEMPLATE_HEADER.version}</Badge>
          <Badge tone="success" dot>{TEMPLATE_HEADER.status}</Badge>
          <Badge tone="info">Read-only</Badge>
        </div>
        <p className="mt-2 text-sm text-slate-600">{TEMPLATE_HEADER.note}</p>
        <p className="mt-1 text-xs text-slate-500">Rule set {GROWER_RULESET_VERSION} — frozen into every accepted quote.</p>
      </Panel>

      <Panel className="mt-6">
        <PanelTitle>Sections</PanelTitle>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">#</th><th className="py-2 pr-3">Section</th><th className="py-2 pr-3">Required</th><th className="py-2 pr-3">Rule reference</th>
                <th className="py-2 pr-3">Current rule behaviour</th><th className="py-2 pr-3">Product mapping</th><th className="py-2">Override policy</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((s) => (
                <tr key={s.n} className="border-b border-slate-100 align-top">
                  <td className="py-3 pr-3 tabular-nums text-slate-400">{s.n}</td>
                  <td className="py-3 pr-3 font-medium text-slate-900">{s.name}<div className="mt-1"><Badge tone={s.treatment === "engineering_review" ? "warning" : s.treatment === "estimator_input" || s.treatment === "charge" ? "neutral" : "info"}>{TREATMENT_LABEL[s.treatment]}</Badge></div></td>
                  <td className="py-3 pr-3"><Badge tone={s.required ? "primary" : "warning"}>{s.required ? "Required" : "Optional"}</Badge><div className="mt-1 max-w-[190px] text-xs text-slate-500">{s.requirementNote}</div></td>
                  <td className="py-3 pr-3 font-mono text-xs text-slate-600">{s.ruleRefs.map((r) => <div key={r}>{r}</div>)}</td>
                  <td className="py-3 pr-3 max-w-[340px] text-slate-700">{s.behaviour}</td>
                  <td className="py-3 pr-3 max-w-[260px] text-slate-700">{s.mappingRef}</td>
                  <td className="py-3 max-w-[260px] text-slate-700">{s.overridePolicy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="mt-6">
        <PanelTitle>How Sean&apos;s answers landed</PanelTitle>
        <ul className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
          {POC_ITEM_REGISTER.map((i) => (
            <li key={i.n} className="rounded-md border border-slate-200 p-3">
              <div className="flex items-center gap-2"><span className="font-medium text-slate-900">{i.topic}</span>
                <Badge tone={i.disposition === "resolved" ? "success" : i.disposition === "manual_by_design" ? "neutral" : "warning"}>{i.disposition === "resolved" ? "Resolved" : i.disposition === "manual_by_design" ? "Manual by design" : "Post-POC"}</Badge></div>
              <p className="mt-1 text-xs text-slate-600">{i.treatment}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </main>
  );
}

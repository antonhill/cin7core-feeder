"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { resolveScheduleChoice, splitContractBySchedule, type ScheduleChoice } from "@/newquip/quote/billing-schedule";
import { bpsToPercentText } from "@/newquip/quote/project-template";
import { fmtCents } from "../fields";
import { listProjectTemplatesAction } from "../template-actions";

// Chooses the commercial billing schedule a NEW project is created with: the built-in 40/55/5 (default), the six-stage schedule, a one-off custom schedule,
// or an active PROJECT TEMPLATE (optionally customised for this one project). The same engine validates (must total exactly 100%) and splits the ex-VAT
// contract to the cent; the server re-reads the template and re-validates whatever is sent. Existing projects are never changed.
type Tpl = { id: string; name: string; isDefault: boolean; version: number; rows: Array<{ name: string; percent: string }> };
const STD_CUSTOM = [{ name: "Deposit", percent: "40" }, { name: "Delivery", percent: "55" }, { name: "Installation", percent: "5" }];

export function ScheduleChooser({ contractCents, onChange }: { contractCents: number; onChange: (c: ScheduleChoice | undefined) => void }) {
  const [key, setKey] = useState<string>("STANDARD"); // STANDARD | SIX_STAGE | CUSTOM | TPL:<id>
  const [custom, setCustom] = useState<Array<{ name: string; percent: string }>>(STD_CUSTOM);
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [edited, setEdited] = useState(false);

  const tpl = key.startsWith("TPL:") ? templates.find((t) => `TPL:${t.id}` === key) ?? null : null;
  const rowsEditable = key === "CUSTOM" || tpl !== null;

  const choice: ScheduleChoice | undefined = useMemo(() => {
    if (key === "STANDARD") return undefined;
    if (key === "SIX_STAGE") return { preset: "SIX_STAGE" };
    if (key === "CUSTOM") return { preset: "CUSTOM", stages: custom };
    return tpl ? { preset: "TEMPLATE", templateId: tpl.id, ...(edited ? { stages: custom } : {}) } : undefined;
  }, [key, custom, tpl, edited]);
  useEffect(() => { onChange(choice); }, [choice, onChange]);

  useEffect(() => {
    listProjectTemplatesAction().then((r) => {
      if (!r.ok || !r.data) return;
      const active: Tpl[] = r.data.templates.filter((t) => t.status === "ACTIVE" && t.latest).map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault, version: t.latest!.version, rows: t.latest!.stages.map((s) => ({ name: s.name, percent: bpsToPercentText(s.bps) })) }));
      setTemplates(active);
      const def = active.find((t) => t.isDefault);
      if (def) { setKey(`TPL:${def.id}`); setCustom(def.rows); setEdited(false); }
    });
  }, []);

  const resolved = useMemo(() => {
    if (tpl && !edited) return resolveScheduleChoice({ preset: "CUSTOM", stages: tpl.rows });
    return resolveScheduleChoice(choice ?? { preset: "STANDARD" });
  }, [choice, tpl, edited]);
  const rows = resolved.ok ? splitContractBySchedule(contractCents, resolved.schedule) : [];
  const shown = tpl && !edited ? tpl.rows : custom;
  const setRows = (n: Array<{ name: string; percent: string }>) => { setCustom(n); if (tpl) setEdited(true); };

  return (
    <div className="mb-4 space-y-3">
      <Select label="Billing schedule" value={key} onChange={(e) => {
        const k = e.target.value; setKey(k); setEdited(false);
        const t = templates.find((x) => `TPL:${x.id}` === k);
        if (t) setCustom(t.rows); else if (k === "CUSTOM") setCustom(STD_CUSTOM);
      }}>
        <option value="STANDARD">NewQuip standard - Deposit 40% / Delivery 55% / Installation 5%</option>
        <option value="SIX_STAGE">Six-stage - 10 / 30 / 20 / 20 / 15 / 5</option>
        {templates.map((t) => <option key={t.id} value={`TPL:${t.id}`}>Template: {t.name} (v{t.version}){t.isDefault ? " - default" : ""}</option>)}
        <option value="CUSTOM">Custom schedule…</option>
      </Select>
      {tpl && <p className="text-xs text-slate-500">{edited ? "Customised for this project only; the template itself is unchanged." : "Edit a stage below to customise it for this project only."}</p>}
      {rowsEditable && (
        <div className="space-y-2">
          {shown.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
              <Input label="Milestone" hideLabel={i !== 0} value={s.name} onChange={(e) => setRows(shown.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input label="Percent" hideLabel={i !== 0} value={s.percent} inputMode="decimal" onChange={(e) => setRows(shown.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
              <Button size="sm" variant="secondary" disabled={shown.length <= 1} onClick={() => setRows(shown.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setRows([...shown, { name: "", percent: "" }])}>Add milestone</Button>
        </div>
      )}
      {resolved.ok ? (
        <ul className="text-sm text-slate-700">
          {rows.map((r) => <li key={r.name} className="tabular-nums">{r.name}: {fmtCents(r.valueCents)} <span className="text-xs text-slate-500">(ex VAT)</span></li>)}
        </ul>
      ) : <Alert tone="danger">{resolved.errors.join(" ")}</Alert>}
    </div>
  );
}

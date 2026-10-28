"use client";

import { useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { resolveScheduleChoice, splitContractBySchedule, type ScheduleChoice, type SchedulePreset } from "@/newquip/quote/billing-schedule";
import { fmtCents } from "../fields";

// Chooses the commercial billing schedule a NEW project is created with. The default is NewQuip's standard 40/55/5. The same engine validates
// (must total exactly 100%) and splits the ex-VAT contract to the cent; the server re-validates whatever is sent. Existing projects are never changed.
export function ScheduleChooser({ contractCents, onChange }: { contractCents: number; onChange: (c: ScheduleChoice | undefined) => void }) {
  const [preset, setPreset] = useState<SchedulePreset>("STANDARD");
  const [custom, setCustom] = useState<Array<{ name: string; percent: string }>>([{ name: "Deposit", percent: "40" }, { name: "Delivery", percent: "55" }, { name: "Installation", percent: "5" }]);

  const choice: ScheduleChoice = useMemo(() => (preset === "CUSTOM" ? { preset, stages: custom } : { preset }), [preset, custom]);
  const resolved = useMemo(() => resolveScheduleChoice(choice), [choice]);
  const rows = resolved.ok ? splitContractBySchedule(contractCents, resolved.schedule) : [];
  const publish = (next: ScheduleChoice) => onChange(next.preset === "STANDARD" ? undefined : next);

  return (
    <div className="mb-4 space-y-3">
      <Select label="Billing schedule" value={preset} onChange={(e) => { const p = e.target.value as SchedulePreset; setPreset(p); publish(p === "CUSTOM" ? { preset: p, stages: custom } : { preset: p }); }}>
        <option value="STANDARD">NewQuip standard - Deposit 40% / Delivery 55% / Installation 5%</option>
        <option value="SIX_STAGE">Six-stage - 10 / 30 / 20 / 20 / 15 / 5</option>
        <option value="CUSTOM">Custom schedule…</option>
      </Select>
      {preset === "CUSTOM" && (
        <div className="space-y-2">
          {custom.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
              <Input label={i === 0 ? "Milestone" : "Milestone"} hideLabel={i !== 0} value={s.name} onChange={(e) => { const n = custom.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)); setCustom(n); publish({ preset, stages: n }); }} />
              <Input label={i === 0 ? "Percent" : "Percent"} hideLabel={i !== 0} value={s.percent} inputMode="decimal" onChange={(e) => { const n = custom.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)); setCustom(n); publish({ preset, stages: n }); }} />
              <Button size="sm" variant="secondary" disabled={custom.length <= 1} onClick={() => { const n = custom.filter((_, j) => j !== i); setCustom(n); publish({ preset, stages: n }); }}>Remove</Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => { const n = [...custom, { name: "", percent: "" }]; setCustom(n); publish({ preset, stages: n }); }}>Add milestone</Button>
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

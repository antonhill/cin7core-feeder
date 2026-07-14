import { describe, expect, it } from "vitest";
import { selectInstances } from "@/reports/instance-picker";
import type { InstancePickerItem } from "@/actions/instances";

function instance(overrides: Partial<InstancePickerItem> = {}): InstancePickerItem {
  return { id: "inst-1", name: "Spark Demo", active: true, ...overrides };
}

describe("selectInstances", () => {
  it("returns no selectable instances and no auto-select for an empty list", () => {
    expect(selectInstances([])).toEqual({ selectableInstances: [], autoSelectedId: null });
  });

  it("auto-selects the single active instance", () => {
    const inst = instance({ id: "a" });
    expect(selectInstances([inst])).toEqual({ selectableInstances: [inst], autoSelectedId: "a" });
  });

  it("does not auto-select when the only instance is inactive", () => {
    const inst = instance({ id: "a", active: false });
    expect(selectInstances([inst])).toEqual({ selectableInstances: [], autoSelectedId: null });
  });

  // Regression test: today's partial auto-select checks the raw unfiltered count, so 1 active + 1
  // inactive instance currently fails to auto-select even though it should — confirmed live 2026-07-14.
  it("auto-selects the one active instance even when an inactive one is also present", () => {
    const active = instance({ id: "a", active: true });
    const inactive = instance({ id: "b", active: false });
    expect(selectInstances([inactive, active])).toEqual({ selectableInstances: [active], autoSelectedId: "a" });
  });

  it("does not auto-select when 2+ active instances exist", () => {
    const a = instance({ id: "a" });
    const b = instance({ id: "b" });
    expect(selectInstances([a, b])).toEqual({ selectableInstances: [a, b], autoSelectedId: null });
  });

  it("excludes inactive instances from the selectable list even when 2+ active ones exist", () => {
    const a = instance({ id: "a", active: true });
    const b = instance({ id: "b", active: true });
    const c = instance({ id: "c", active: false });
    expect(selectInstances([a, b, c])).toEqual({ selectableInstances: [a, b], autoSelectedId: null });
  });
});

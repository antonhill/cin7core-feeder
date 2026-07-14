import type { InstancePickerItem } from "@/actions/instances";

export interface SelectedInstances {
  /** Active instances only — an inactive instance can never actually be used (loadCin7Credentials/runSync both hard-throw against one), so there's nothing to offer by showing it selectable-but-disabled. */
  selectableInstances: InstancePickerItem[];
  /** Set only when exactly one active instance exists — the signal to skip the picker UI entirely and just use it. */
  autoSelectedId: string | null;
}

/** Pure decision logic behind useInstancePicker — no React, so it's trivially testable with plain arrays in/out. */
export function selectInstances(instances: InstancePickerItem[]): SelectedInstances {
  const selectableInstances = instances.filter((i) => i.active);
  return {
    selectableInstances,
    autoSelectedId: selectableInstances.length === 1 ? selectableInstances[0].id : null,
  };
}

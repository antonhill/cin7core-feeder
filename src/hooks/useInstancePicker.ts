"use client";

import { useEffect, useState, useTransition } from "react";
import { listInstancesForPicker } from "@/actions/instances";
import { selectInstances } from "@/reports/instance-picker";
import type { InstancePickerItem } from "@/actions/instances";

export interface UseInstancePickerResult {
  selectableInstances: InstancePickerItem[];
  isLoading: boolean;
  error: string | null;
  instanceId: string | null;
  setInstanceId: (id: string | null) => void;
  /** True once exactly one active instance was found and auto-selected — lets InstancePicker render just "Instance: {name}" instead of a control. */
  isAutoSelected: boolean;
  reload: () => void;
}

/**
 * Fetches the org's Cin7 instances on mount (not behind a manual "Load
 * instances" click, unlike every page this replaces) and auto-selects the
 * one active instance when there's only one — see selectInstances() for the
 * actual decision logic. The fetch itself is a cheap, RLS-scoped query with
 * no secrets (id/name/active only), so firing it unconditionally on mount
 * across every consuming page is an acceptable, deliberate behavior change
 * from the previous on-demand pattern.
 */
export function useInstancePicker(): UseInstancePickerResult {
  const [selectableInstances, setSelectableInstances] = useState<InstancePickerItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, startTransition] = useTransition();
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [isAutoSelected, setIsAutoSelected] = useState(false);

  function load() {
    startTransition(async () => {
      setError(null);
      const res = await listInstancesForPicker();
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      const { selectableInstances: selectable, autoSelectedId } = selectInstances(res.instances ?? []);
      setSelectableInstances(selectable);
      if (autoSelectedId) {
        setInstanceId(autoSelectedId);
        setIsAutoSelected(true);
      } else {
        setIsAutoSelected(false);
      }
    });
  }

  useEffect(load, []);

  return { selectableInstances, isLoading, error, instanceId, setInstanceId, isAutoSelected, reload: load };
}

"use client";

import { useEffect, useState, useTransition } from "react";
import {
  loadPickingCalendarOrdersAction,
  updatePickingShipByAction,
  getPickingCalendarSettingsAction,
  savePickingCalendarSettingsAction,
} from "./actions";
import type { OrderFulfillmentRow } from "@/reports/query";
import { ReportDescription } from "../ReportDescription";
import { CalendarBoard } from "../shipping-calendar/calendar-board";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Panel } from "@/components/ui/Panel";

/** Reuses is_pick_today (report_order_fulfillment, migrations 0061-0063) unchanged per the brief — no separate Picking Calendar qualification logic. */
function isPickToday(order: OrderFulfillmentRow): boolean {
  return order.is_pick_today;
}

function hiddenByFloor(order: OrderFulfillmentRow): boolean {
  return order.pick_today_hidden_by_floor;
}

const MIN_OFFSET_DAYS = 0;
const MAX_OFFSET_DAYS = 7;
// Mirrors the private default inside actions.ts — only used here as a
// last-resort fallback if the load itself fails (e.g. a permissions error),
// since getPickingCalendarSettingsAction always applies the real default
// server-side on success.
const FALLBACK_OFFSET_DAYS = 1;

export default function PickingCalendarPage() {
  const [offsetDays, setOffsetDays] = useState<number | null>(null);
  const [savedOffsetDays, setSavedOffsetDays] = useState<number | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isSaving, startSaveTransition] = useTransition();

  useEffect(() => {
    getPickingCalendarSettingsAction().then((result) => {
      const value = result.ok && result.data ? result.data.offsetDays : FALLBACK_OFFSET_DAYS;
      setOffsetDays(value);
      setSavedOffsetDays(value);
      if (!result.ok) setSettingsError(result.error ?? "Unknown error");
    });
  }, []);

  function handleSaveOffset() {
    if (offsetDays === null) return;
    setSettingsError(null);
    startSaveTransition(async () => {
      const result = await savePickingCalendarSettingsAction(offsetDays);
      if (!result.ok) {
        setSettingsError(result.error ?? "Unknown error");
        return;
      }
      setSavedOffsetDays(offsetDays);
    });
  }

  return (
    <>
      <ReportDescription title="Picking Calendar">
        Every order due for picking, laid out on a week grid — the same board as Shipping Calendar, offset N working
        day(s) earlier so pick staff see &ldquo;when to pick,&rdquo; not &ldquo;when to ship.&rdquo; A card here is
        exactly Order Fulfillment&rsquo;s Pick Today queue; dragging a card or using its detail&rsquo;s{" "}
        <strong>Move to</strong> picker writes the new Ship By date straight back to Cin7 Core, the same as Shipping
        Calendar.
      </ReportDescription>

      <Panel className="mt-6 flex flex-wrap items-end gap-3">
        <Input
          type="number"
          label="Show orders for picking this many working day(s) before Ship By"
          min={MIN_OFFSET_DAYS}
          max={MAX_OFFSET_DAYS}
          value={offsetDays ?? ""}
          disabled={offsetDays === null || isSaving}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isFinite(value)) setOffsetDays(Math.min(MAX_OFFSET_DAYS, Math.max(MIN_OFFSET_DAYS, value)));
          }}
          className="w-24"
        />
        <Button onClick={handleSaveOffset} disabled={offsetDays === null || offsetDays === savedOffsetDays} loading={isSaving}>
          {isSaving ? "Saving…" : "Save"}
        </Button>
        {settingsError && (
          <div className="w-full">
            <Alert tone="danger">{settingsError}</Alert>
          </div>
        )}
      </Panel>

      {savedOffsetDays !== null && (
        <CalendarBoard
          offsetDays={savedOffsetDays}
          dateLabel="Pick By"
          qualifies={isPickToday}
          hiddenByFloor={hiddenByFloor}
          loadOrders={loadPickingCalendarOrdersAction}
          writeShipBy={updatePickingShipByAction}
        />
      )}
    </>
  );
}

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processBomAlerts } from "@/lib/bom-alerts";
import { findBomSkus } from "@/cin7/products";
import { sendEmail } from "@/lib/email/resend";

vi.mock("@/cin7/products", () => ({ findBomSkus: vi.fn() }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

interface FakeDbOptions {
  bomAlertSettings?: { enabled: boolean; warehouse_manager_email: string | null } | null;
  sale?: { order_number: string | null; customer_name: string | null; bom_alert_sent_at: string | null } | null;
  lines?: { product_sku: string | null }[];
}

function makeFakeDb(opts: FakeDbOptions) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];

  function chain(table: string, terminalResult: () => { data?: unknown; error?: unknown }) {
    const obj: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        calls.push({ table, op: "select", args });
        return obj;
      },
      eq: (...args: unknown[]) => {
        calls.push({ table, op: "eq", args });
        return obj;
      },
      maybeSingle: async () => terminalResult(),
      then: (resolve: (v: unknown) => void) => resolve(terminalResult()),
    };
    return obj;
  }

  const db = {
    from: (table: string) => {
      if (table === "bom_alert_settings") return chain(table, () => ({ data: opts.bomAlertSettings ?? null, error: null }));
      if (table === "sales") {
        return {
          select: (...args: unknown[]) => {
            calls.push({ table, op: "select", args });
            return chain(table, () => ({ data: opts.sale ?? null, error: null }));
          },
          update: (patch: unknown) => {
            calls.push({ table, op: "update", args: [patch] });
            return chain(table, () => ({ error: null }));
          },
        };
      }
      if (table === "sale_order_lines") return chain(table, () => ({ data: opts.lines ?? [], error: null }));
      if (table === "bom_alert_notifications") {
        return {
          insert: (rows: unknown) => {
            calls.push({ table, op: "insert", args: [rows] });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Unhandled table in fake db: ${table}`);
    },
  };

  return { db: db as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  vi.mocked(findBomSkus).mockReset();
  vi.mocked(sendEmail).mockReset();
});

describe("processBomAlerts", () => {
  it("does nothing when given no transitioned sales", async () => {
    const { db, calls } = makeFakeDb({});
    await processBomAlerts(db, "org1", "inst-1", creds, []);
    expect(calls).toHaveLength(0);
  });

  it("no-ops when bom_alert_settings isn't configured for the org", async () => {
    const { db, calls } = makeFakeDb({ bomAlertSettings: null });
    await processBomAlerts(db, "org1", "inst-1", creds, ["sale-1"]);
    expect(calls.filter((c) => c.table === "sales")).toHaveLength(0);
    expect(findBomSkus).not.toHaveBeenCalled();
  });

  it("no-ops when enabled but no warehouse_manager_email is set", async () => {
    const { db } = makeFakeDb({ bomAlertSettings: { enabled: true, warehouse_manager_email: null } });
    await processBomAlerts(db, "org1", "inst-1", creds, ["sale-1"]);
    expect(findBomSkus).not.toHaveBeenCalled();
  });

  it("skips a sale that's already been alerted (bom_alert_sent_at set)", async () => {
    const { db } = makeFakeDb({
      bomAlertSettings: { enabled: true, warehouse_manager_email: "wm@example.com" },
      sale: { order_number: "SO-1", customer_name: "Acme", bom_alert_sent_at: "2026-08-01T00:00:00.000Z" },
    });
    await processBomAlerts(db, "org1", "inst-1", creds, ["sale-1"]);
    expect(findBomSkus).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a sale with no cached lines yet rather than guessing", async () => {
    const { db } = makeFakeDb({
      bomAlertSettings: { enabled: true, warehouse_manager_email: "wm@example.com" },
      sale: { order_number: "SO-1", customer_name: "Acme", bom_alert_sent_at: null },
      lines: [],
    });
    await processBomAlerts(db, "org1", "inst-1", creds, ["sale-1"]);
    expect(findBomSkus).not.toHaveBeenCalled();
  });

  it("checks the sale's cached SKUs, but sends nothing when none are BOM products", async () => {
    vi.mocked(findBomSkus).mockResolvedValue([]);
    const { db } = makeFakeDb({
      bomAlertSettings: { enabled: true, warehouse_manager_email: "wm@example.com" },
      sale: { order_number: "SO-1", customer_name: "Acme", bom_alert_sent_at: null },
      lines: [{ product_sku: "SKU-A" }, { product_sku: "SKU-B" }],
    });
    await processBomAlerts(db, "org1", "inst-1", creds, ["sale-1"]);
    expect(findBomSkus).toHaveBeenCalledWith(creds, ["SKU-A", "SKU-B"]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends, logs, and marks the sale alerted when a BOM SKU is found", async () => {
    vi.mocked(findBomSkus).mockResolvedValue(["SKU-A"]);
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, messageId: "msg-1" });
    const { db, calls } = makeFakeDb({
      bomAlertSettings: { enabled: true, warehouse_manager_email: "wm@example.com" },
      sale: { order_number: "SO-1", customer_name: "Acme", bom_alert_sent_at: null },
      lines: [{ product_sku: "SKU-A" }],
    });

    await processBomAlerts(db, "org1", "inst-1", creds, ["sale-1"]);

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ["wm@example.com"] }));
    const logCall = calls.find((c) => c.table === "bom_alert_notifications" && c.op === "insert");
    expect(logCall?.args[0]).toMatchObject({
      cin7_sale_id: "sale-1",
      bom_skus: ["SKU-A"],
      recipient: "wm@example.com",
      provider_message_id: "msg-1",
      error: null,
    });
    const updateCall = calls.find((c) => c.table === "sales" && c.op === "update");
    expect(updateCall?.args[0]).toHaveProperty("bom_alert_sent_at");
  });

  it("logs a failed send without throwing, and still marks the sale alerted (no retry storm)", async () => {
    vi.mocked(findBomSkus).mockResolvedValue(["SKU-A"]);
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "Resend down" });
    const { db, calls } = makeFakeDb({
      bomAlertSettings: { enabled: true, warehouse_manager_email: "wm@example.com" },
      sale: { order_number: "SO-1", customer_name: "Acme", bom_alert_sent_at: null },
      lines: [{ product_sku: "SKU-A" }],
    });

    await expect(processBomAlerts(db, "org1", "inst-1", creds, ["sale-1"])).resolves.toBeUndefined();

    const logCall = calls.find((c) => c.table === "bom_alert_notifications" && c.op === "insert");
    expect(logCall?.args[0]).toMatchObject({ sent_at: null, error: "Resend down" });
  });
});

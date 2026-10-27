// TEMPORARY (investigation branch): read-only T0 proof inspector. Delete after the proof. GET only - no form, no action, no mutation.
import { notFound } from "next/navigation";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAvailabilityForSku, fetchSaleForInspection } from "@/cin7/sale-inspect";
import { T0AccessError, T0_INSTANCE_ID, T0_ORG_ID, buildT0Report } from "@/lib/cin7-proof/t0";

export const dynamic = "force-dynamic";

export default async function T0InspectorPage({ searchParams }: { searchParams: Promise<{ sale?: string | string[] }> }) {
  const { orgId } = await requireCurrentOrg();
  if (orgId !== T0_ORG_ID) notFound();
  let isManager = false;
  try { await requireOrgAdmin("run the T0 inspector"); isManager = true; } catch { isManager = false; }
  if (!isManager) notFound();

  const sp = await searchParams;
  const saleParam = typeof sp.sale === "string" && sp.sale.trim() !== "" ? sp.sale.trim() : null;
  const db = createServiceRoleClient();
  const creds = () => loadCin7Credentials(db, T0_ORG_ID, T0_INSTANCE_ID);

  let report;
  let failure: string | null = null;
  try {
    report = await buildT0Report({ orgId, isManager }, saleParam, {
      readAvailability: async (sku) => fetchAvailabilityForSku(await creds(), sku),
      readSale: async (id) => fetchSaleForInspection(await creds(), id),
    });
  } catch (e) {
    if (e instanceof T0AccessError) notFound();
    failure = e instanceof Error ? e.message.slice(0, 200) : "Unexpected error";
  }

  return (
    <main style={{ padding: 24, fontFamily: "monospace", maxWidth: 1100 }}>
      <h1>T0 proof inspector (temporary, read-only)</h1>
      {failure && <p>Error: {failure}</p>}
      {report && (
        <>
          <p>Mode: <b>{report.mode}</b> | generated {report.generatedAt} | verdict: <b>{report.verdict}</b></p>
          {report.error && <p>Note: {report.error}</p>}
          <h2>Stock: NQ2886 (live)</h2>
          <pre>{report.availability.length === 0 ? "(no availability rows)" : report.availability.map((a) => `${a.location ?? "?"}: on hand ${a.onHand ?? "n/a"} | allocated ${a.allocated ?? "n/a"} | available ${a.available ?? "n/a"} | on order ${a.onOrder ?? "n/a"} | in transit ${a.inTransit ?? "n/a"}`).join("\n")}</pre>
          <h2>Checks</h2>
          <pre>{report.checks.map((c) => `${c.result.padEnd(12)} ${c.id.padEnd(4)} ${c.label}\n             expected: ${c.expected}\n             actual:   ${c.actual}`).join("\n")}</pre>
          {report.sale && (
            <>
              <h2>Sale (allow-listed fields only)</h2>
              <pre>{JSON.stringify(report.sale, null, 2)}</pre>
            </>
          )}
        </>
      )}
    </main>
  );
}

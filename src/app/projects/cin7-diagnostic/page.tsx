// TEMPORARY (PR #122): read-only Cin7 sale classification check. Delete after the result is captured.
import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { isNewquipPocOrg } from "@/newquip/access";
import { buildCin7Port, singleActiveInstanceId } from "@/lib/projects/cin7-adapter";
import { classifyDiagnosticSales } from "@/lib/projects/cin7-sale-diagnostic";

export const dynamic = "force-dynamic";

export default async function Cin7DiagnosticPage() {
  const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
  if (!isNewquipPocOrg(orgId)) notFound();
  let isManager = false;
  try { await requireOrgAdmin("run the Cin7 diagnostic"); isManager = true; } catch { isManager = false; }
  if (!isManager) notFound();

  const db = createServiceRoleClient();
  let rows: Awaited<ReturnType<typeof classifyDiagnosticSales>> = [];
  let failure: string | null = null;
  try {
    const port = buildCin7Port(db, orgId, await singleActiveInstanceId(db, orgId));
    rows = await classifyDiagnosticSales({ orgEnabled: true, isManager }, (id) => port.fetchSale(id));
  } catch (e) {
    failure = e instanceof Error ? e.message.slice(0, 200) : "Unexpected error";
  }
  return (
    <main style={{ padding: 24, fontFamily: "monospace" }}>
      <h1>Cin7 sale classification (temporary, read-only)</h1>
      {failure && <p>Error: {failure}</p>}
      {rows.map((r) => (
        <pre key={r.label}>{`${r.label}\n  SaleID:          ${r.saleId ?? "(none)"}\n  Type:            ${r.type}\n  TaxRule:         ${r.taxRule}\n  Order.Status:    ${r.orderStatus}\n  SaleOrderNumber: ${r.saleOrderNumber}${r.error ? `\n  error:           ${r.error}` : ""}`}</pre>
      ))}
    </main>
  );
}

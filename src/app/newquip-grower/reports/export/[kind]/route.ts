import { NextResponse } from "next/server";
import { reportSession } from "@/lib/newquip-reports/session";
import { exportReport, REPORT_KINDS, type ReportKind } from "@/lib/newquip-reports/service";
import { parseFilters } from "@/lib/newquip-reports/params";

// Excel export. Re-authorises on every request and builds the workbook with the SAME functions as the page, for the SAME viewer, so it can contain nothing the viewer may not see:
// the costing export is refused outright for a viewer without cost entitlement, and the operational exports carry no commercial column at all.
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: "Unknown report." }, { status: 404 });
  let session: Awaited<ReturnType<typeof reportSession>>;
  try { session = await reportSession(); } catch { return NextResponse.json({ error: "Not authorised." }, { status: 403 }); }
  const { viewer, db } = session;
  if (kind === "costing" && !viewer.canSeeCost) return NextResponse.json({ error: "Costing and margin reporting is restricted to Estimators and Managers." }, { status: 403 });
  if (kind === "overview" && !viewer.roles.has("manager")) return NextResponse.json({ error: "The Management Overview is available to Managers." }, { status: 403 });
  const url = new URL(req.url); const f = parseFilters(Object.fromEntries(url.searchParams));
  try {
    const { buffer, fileName } = await exportReport(db, viewer, kind as ReportKind, f);
    return new NextResponse(new Uint8Array(buffer), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "no-store, private" } });
  } catch { return NextResponse.json({ error: "The export could not be built." }, { status: 500 }); }
}

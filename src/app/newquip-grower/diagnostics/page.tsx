import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/supabase/server";
import { authoriseDiagnostic } from "./authorise";
import { DiagnosticClient } from "./DiagnosticClient";

// Internal, cost-bearing, never cached. 404 unless the env gate is on AND the viewer passes the same authorisation the action re-checks. The page renders only;
// it writes nothing (refusals are audited by the action, never by a page view).
export const dynamic = "force-dynamic";
// Applies to the Server Action invoked from this page (a run is paced, ~240s budget + backoff). 300s is the Vercel Pro ceiling; the plan limit is not known here:
// on a lower plan the platform clamps it and a long run may be cut off, so keep lists short there.
export const maxDuration = 300;

export default async function Cin7DiagnosticPage() {
  const auth = await authoriseDiagnostic(createServiceRoleClient());
  if (!auth.ok) notFound();
  return <DiagnosticClient />;
}

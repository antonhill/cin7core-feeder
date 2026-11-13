import { notFound } from "next/navigation";
import { authoriseDiagnostic } from "./authorise";
import { DiagnosticClient } from "./DiagnosticClient";

// Internal, cost-bearing, never cached. 404 unless the env gate is on AND the viewer passes the same authorisation the action re-checks.
export const dynamic = "force-dynamic";

export default async function Cin7DiagnosticPage() {
  const auth = await authoriseDiagnostic();
  if (!auth.ok) notFound();
  return <DiagnosticClient />;
}

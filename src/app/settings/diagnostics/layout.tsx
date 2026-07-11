import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/require-super-admin";

/** Same gate as /admin/layout.tsx — silently redirects home rather than showing an error, so the route's existence isn't advertised to non-super-admins. */
export default async function DiagnosticsLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireSuperAdmin();
  } catch {
    redirect("/");
  }
  return <>{children}</>;
}

import { redirect } from "next/navigation";
import { requireOrgAdmin } from "@/lib/require-org-admin";

/**
 * Unlike /admin (deliberately silent on denial, since it's a super-admin
 * tool that shouldn't advertise its own existence), a `member`-role user
 * landing here is a real paying customer, not an access-boundary probe —
 * the redirect carries a query param so the home page can show a plain
 * explanation instead of a bare, unexplained bounce.
 */
export default async function MembersLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireOrgAdmin();
  } catch {
    redirect("/?teamAccessDenied=1");
  }
  return <>{children}</>;
}

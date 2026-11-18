import { redirect } from "next/navigation";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";

// Claims is a NewQuip area (the organisation's progress claims across its projects). Anyone outside the NewQuip organisation is bounced home as if the route did not
// exist for them; the page re-checks module access itself.
export default async function ClaimsLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireNewquipPocOrg();
  } catch {
    redirect("/");
  }
  return <>{children}</>;
}

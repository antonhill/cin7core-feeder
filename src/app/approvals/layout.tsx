import { redirect } from "next/navigation";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";

// The POC is visible only to the NewQuip organisation (see src/newquip/access.ts). Everyone else is
// bounced home exactly as if the route didn't exist for them; the actions re-check independently.
export default async function ApprovalsLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireNewquipPocOrg();
  } catch {
    redirect("/");
  }
  return <>{children}</>;
}

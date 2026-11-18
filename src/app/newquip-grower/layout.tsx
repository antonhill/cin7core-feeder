import { redirect } from "next/navigation";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { currentSwitchState } from "./actor";
import { RoleSwitcher } from "./RoleSwitcher";

// Automatic pricing reads Cin7 for up to 40 s inside a server action of these pages (Rep save, hand-off, Estimator 'Price from Cin7'): give the function room so a platform timeout can never fail a save or submit.
export const maxDuration = 120;

// The POC is visible only to the NewQuip organisation (see src/newquip/access.ts). Everyone else is
// bounced home exactly as if the route didn't exist for them; the actions re-check independently.
export default async function NewquipGrowerLayout({ children }: { children: React.ReactNode }) {
  let orgId: string; let userId: string;
  try {
    ({ orgId, userId } = await requireNewquipPocOrg());
  } catch {
    redirect("/");
  }
  // The role switch is offered only to an allowlisted person holding at least two explicit process roles; for everyone else this is null and nothing renders.
  const sw = await currentSwitchState(orgId, userId);
  return <>{sw ? <RoleSwitcher held={sw.held} active={sw.active} /> : null}{children}</>;
}

import { redirect } from "next/navigation";
import { requireCasaDasNatasOrg } from "@/lib/require-casa-das-natas-org";

export default async function NatasReportLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireCasaDasNatasOrg();
  } catch {
    redirect("/reports");
  }
  return <>{children}</>;
}

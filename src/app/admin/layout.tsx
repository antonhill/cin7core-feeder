import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/require-super-admin";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireSuperAdmin();
  } catch {
    redirect("/");
  }
  return <>{children}</>;
}

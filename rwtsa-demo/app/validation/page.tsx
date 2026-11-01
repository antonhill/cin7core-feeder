import { ValidationPageView } from "../../components/Views";
import { getDemoState } from "../../lib/state";
import { validationView } from "@/rwtsa-demo/state/demo-state";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <ValidationPageView view={validationView(await getDemoState())} />;
}

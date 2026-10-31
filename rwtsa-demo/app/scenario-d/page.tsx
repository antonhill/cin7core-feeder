import { ScenarioPageView } from "../../components/Views";
import { getDemoState } from "../../lib/state";
import { scenarioView } from "@/rwtsa-demo/state/demo-state";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <ScenarioPageView view={scenarioView(await getDemoState(), "D")} />;
}

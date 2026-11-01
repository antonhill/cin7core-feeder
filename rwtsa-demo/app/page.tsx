import { OverviewPageView } from "../components/Views";
import { getDemoState } from "../lib/state";
import { overviewView } from "@/rwtsa-demo/state/demo-state";

// Rendered per request: the workbook is read at request time, never at build time, so no workbook-derived data
// can end up in the build output.
export const dynamic = "force-dynamic";

export default async function Page() {
  return <OverviewPageView view={overviewView(await getDemoState())} />;
}

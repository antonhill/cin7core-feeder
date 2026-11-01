import { LandedPageView } from "../../components/LandedCost";
import { getDemoState } from "../../lib/state";
import { landedModel } from "@/rwtsa-demo/state/landed-model";
import { parseLandedSettings } from "@/rwtsa-demo/state/landed-settings";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const settings = parseLandedSettings(await searchParams);
  return <LandedPageView model={landedModel(await getDemoState(), settings)} />;
}

import { ManufacturingPageView } from "../../components/Manufacturing";
import { getDemoState } from "../../lib/state";
import { mfgModel, suggestedScaleFor } from "@/rwtsa-demo/state/mfg-model";
import { parseMfgSettings } from "@/rwtsa-demo/state/mfg-settings";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getDemoState();
  const settings = parseMfgSettings(await searchParams, { suggestedScale: suggestedScaleFor(state) });
  return <ManufacturingPageView model={mfgModel(state, settings)} />;
}

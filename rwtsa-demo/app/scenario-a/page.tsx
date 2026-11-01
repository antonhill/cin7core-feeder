import { RedFlagPageView } from "../../components/RedFlag";
import { getDemoState } from "../../lib/state";
import { readExclusions } from "../../lib/exclusions";
import { isOutcome } from "@/rwtsa-demo/state/exclusion-form";
import { provenanceOf } from "@/rwtsa-demo/state/demo-state";
import { redFlagModel, suppliedCurveFor } from "@/rwtsa-demo/state/red-flag-model";
import { parseSettings } from "@/rwtsa-demo/state/red-flag-settings";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const state = await getDemoState();
  const settings = parseSettings(query, { suppliedCurve: suppliedCurveFor(state), requireChoices: provenanceOf(state) === "LOCAL WORKBOOK" });
  const saved = readExclusions(state);
  const done = typeof query.done === "string" ? query.done : null;
  return <RedFlagPageView model={redFlagModel(state, settings, saved.exclusions, saved.error)} outcome={isOutcome(done) ? done : null} />;
}

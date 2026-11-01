import { QuoteConversionPageView } from "../../components/QuoteConversion";
import { getDemoState } from "../../lib/state";
import { crmModel } from "@/rwtsa-demo/state/crm-model";
import { parseCrmSettings } from "@/rwtsa-demo/state/crm-settings";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getDemoState();
  return <QuoteConversionPageView model={crmModel(state, parseCrmSettings(await searchParams))} />;
}

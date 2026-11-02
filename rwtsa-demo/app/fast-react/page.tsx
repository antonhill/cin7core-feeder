import { FastReactPageView } from "../../components/FastReactExchange";
import { readExchange } from "../../lib/fastreact";
import { getDemoState } from "../../lib/state";
import { fastReactModel } from "@/rwtsa-demo/state/fastreact-model";
import { FORM_MESSAGES, type FormOutcome } from "@/rwtsa-demo/state/fastreact-form";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getDemoState();
  const { exchange, error } = readExchange(state);
  const sp = await searchParams;
  const done = typeof sp.done === "string" && Object.hasOwn(FORM_MESSAGES, sp.done) ? (sp.done as FormOutcome) : null;
  return <FastReactPageView model={fastReactModel(state, exchange, error, new Date())} done={done === null ? null : { code: done, text: FORM_MESSAGES[done] }} />;
}

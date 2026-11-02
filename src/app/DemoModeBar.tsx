import { demoBarState } from "@/lib/demo-mode/context";
import { DemoModeControls } from "./DemoModeControls";

/** Server component: renders nothing for anyone but the authorised owner on an enabled Preview (or while a live demo context exists). */
export async function DemoModeBar({ orgId, email }: { orgId: string | null; email: string | null }) {
  const state = await demoBarState({ orgId, email });
  if (!state.visible) return null;
  return <DemoModeControls state={state} />;
}

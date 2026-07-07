import { MODULES, INSTANCES_MODULE } from "./module-nav";

export interface TourStep {
  href: string;
  label: string;
  blurb: string;
}

export const CONNECT_STEP: TourStep = {
  href: "/settings/instances?openAdd=1",
  label: "Connect your first instance",
  blurb: "Everything else in the tour needs at least one connected Cin7 Core instance.",
};

/** Mirrors MODULES' order, minus Instances — CONNECT_STEP already covers that one. */
export function getTourSteps(disabledModules: string[]): TourStep[] {
  const rest = MODULES.filter((m) => m.href !== INSTANCES_MODULE.href && !disabledModules.includes(m.href)).map((m) => ({
    href: m.href,
    label: m.label,
    blurb: m.blurb,
  }));
  return [CONNECT_STEP, ...rest];
}

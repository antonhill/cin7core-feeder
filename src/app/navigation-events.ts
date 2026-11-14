// UX-007: code that navigates programmatically (router.push / replace / location.replace) announces it here so the global NavigationProgress bar shows at once.
export const NAVIGATION_START_EVENT = "nq:navigation-start";

export function announceNavigation(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NAVIGATION_START_EVENT));
}

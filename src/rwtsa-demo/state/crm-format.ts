/** Rate display for Scenario D. N/A for no closed quotes; edges are never rounded into a false 0.0% or 100.0%. */
export function formatRate(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return "N/A";
  if (n > 0 && n < 0.05) return "<0.1%";
  if (n < 100 && n >= 99.95) return ">99.9%";
  return `${n.toFixed(1)}%`;
}

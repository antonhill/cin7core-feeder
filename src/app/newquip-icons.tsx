// Small inline SVG icon set for NewQuip pages (24px grid, 1.75 stroke, currentColor). Decorative: always aria-hidden. No icon dependency is installed, so these are drawn here.
export type NqIconName = "draft" | "estimator" | "manager" | "approved" | "projects" | "claims" | "approvals" | "settings" | "plus" | "building" | "coin" | "template" | "survey" | "members" | "shield" | "bell" | "chevron";

const PATHS: Record<NqIconName, string> = {
  draft: "M4 20h4l10-10-4-4L4 16v4zM14 6l4 4",
  estimator: "M5 3h14v18H5zM8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M8 18h8",
  manager: "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3zM9 12l2 2 4-4",
  approved: "M12 21a9 9 0 100-18 9 9 0 000 18zM8 12l3 3 5-6",
  projects: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z",
  claims: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6",
  approvals: "M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h9",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6",
  plus: "M12 5v14M5 12h14",
  building: "M4 21V5l8-2v18M12 8h8v13M8 8h1M8 12h1M8 16h1M16 12h1M16 16h1M3 21h18",
  coin: "M12 21a9 9 0 100-18 9 9 0 000 18zM14.5 9.5C14 8.5 13 8 12 8c-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5V8M12 16v1.5",
  template: "M4 5h16v4H4zM4 13h7v6H4zM15 13h5v6h-5z",
  survey: "M5 4h14v16H5zM9 9h6M9 13h6M9 17h3",
  members: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.5a3 3 0 010 5M18 14.5c1.8.8 3 2.6 3 5.5",
  shield: "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z",
  bell: "M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zM10 21h4",
  chevron: "M9 6l6 6-6 6",
};

export function NqIcon({ name, className = "h-5 w-5" }: { name: NqIconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      <path d={PATHS[name]} />
    </svg>
  );
}

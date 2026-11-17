// NewQuip Settings hub entries (pure). Visibility mirrors how each destination page already gates itself, so the hub never offers a link that would 404 or redirect:
//   Company details, Project templates  open for every NewQuip member (editing is checked inside the page / its actions);
//   Cost survey                         404s unless the viewer is cost-entitled and not in Demo Mode (cost-survey/page.tsx);
//   Members                             redirects unless the viewer is an org owner/admin (settings/members/layout.tsx);
//   Security, Notifications             every signed-in member.
//
//   Commercial settings                 Manager role only (the page's actions refuse anyone else): FX, freight, markup and cost-age escalation for automatic pricing.
export interface SettingsEntry { href: string; label: string; description: string }

export function settingsEntries(v: { isOrgAdmin: boolean; canSeeCost: boolean; demo: boolean; isManager?: boolean }): SettingsEntry[] {
  const e: SettingsEntry[] = [
    { href: "/newquip-grower/company-profile", label: "Company details", description: "Company details and quotation terms printed on every customer quotation." },
    { href: "/newquip-grower/project-templates", label: "Project templates", description: "Billing milestone templates that seed the stages of a new project." },
  ];
  if (v.canSeeCost && !v.demo) e.push({ href: "/newquip-grower/cost-survey", label: "Cost survey", description: "Internal cost coverage survey (Manager and Estimator)." });
  if (v.isManager) e.push({ href: "/newquip-grower/commercial-settings", label: "Commercial settings", description: "Cost-age escalation, exchange rates, freight and markup used by automatic supplier pricing (Manager only)." });
  if (v.isManager || v.isOrgAdmin) e.push({ href: "/newquip-grower/team", label: "Team and invitations", description: "Invite people to NewQuip and choose their role: Rep, Estimator or Manager (Manager only)." });
  if (v.isOrgAdmin) e.push({ href: "/settings/members", label: "Members", description: "Invite people and manage who can use NewQuip." });
  e.push(
    { href: "/settings/security", label: "Security", description: "Two-factor authentication and sign-in security." },
    { href: "/settings/notifications", label: "Notifications", description: "Which approval and activity emails you receive." },
  );
  return e;
}

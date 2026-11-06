// Operational off switch for the Phase H approvals engine (e.g. for a demo). NEXT_PUBLIC_ so the same value is inlined for server and client code at build time;
// changing it needs a redeploy. When set to "1" the engine behaves as if migration 0110 were absent: documents use their own approve / return buttons,
// the Approvals module is hidden and nothing is written to the approval tables. No data is touched, and unsetting the variable switches it back on.
export const APPROVALS_DISABLED = process.env.NEXT_PUBLIC_NEWQUIP_APPROVALS_DISABLED === "1";

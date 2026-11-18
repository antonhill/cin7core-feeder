// WHERE THE UAT DEMONSTRATION TOOLS ARE AVAILABLE (pure). Two places only, and never on Toolbox Production:
//  - a Vercel Preview deployment (VERCEL_ENV === "preview"); and
//  - the dedicated newquip-uat project, which deploys to its own Production target, recognised by BOTH explicit settings that exist only there: NEWQUIP_UAT_DEMO_TOOLS === "true" AND
//    CIN7_CREDENTIAL_STORE === "uat". One flag set by mistake is not enough. Authentication, the NewQuip organisation check and role checks are unchanged: this only decides whether the controls are drawn.
export function demoToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === "preview") return true;
  return env.NEWQUIP_UAT_DEMO_TOOLS === "true" && env.CIN7_CREDENTIAL_STORE === "uat";
}

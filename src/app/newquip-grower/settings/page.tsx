import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { authoriseActor } from "../actor";
import { settingsEntries, type SettingsEntry } from "@/newquip/settings-entries";
import { SettingsList } from "./SettingsList";

// NewQuip Settings hub. Lists only what the viewer can open (see src/newquip/settings-entries.ts); each destination still enforces its own access. Read-only.
export const dynamic = "force-dynamic";

export default async function NewquipSettingsPage() {
  let entries: SettingsEntry[] = [];
  let error: string | null = null;
  try {
    const a = await authoriseActor();
    entries = settingsEntries({ isOrgAdmin: a.tier === "admin", canSeeCost: a.canSeeCost, demo: !!a.demo });
  } catch {
    // Fail closed to what needs no NewQuip role: sign-in security and notifications.
    entries = settingsEntries({ isOrgAdmin: false, canSeeCost: false, demo: false }).filter((e) => e.href.startsWith("/settings/"));
    error = "Some settings are hidden because your NewQuip access could not be confirmed.";
  }
  return (
    <main className={`${pageContainerClass("form", "compact")} space-y-4`}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-700">NewQuip company, project and account settings.</p>
      </div>
      {error && <Alert tone="info">{error}</Alert>}
      <SettingsList entries={entries} />
    </main>
  );
}

import Link from "next/link";
import { NqIcon, type NqIconName } from "@/app/newquip-icons";
import type { SettingsEntry } from "@/newquip/settings-entries";

// Presentation only: the icon is looked up by destination, so the entries (and who may see them) stay exactly what settingsEntries() returns.
const ICONS: Record<string, NqIconName> = {
  "/newquip-grower/company-profile": "building",
  "/newquip-grower/commercial-settings": "coin",
  "/newquip-grower/project-templates": "template",
  "/newquip-grower/cost-survey": "survey",
  "/settings/members": "members",
  "/settings/security": "shield",
  "/settings/notifications": "bell",
};

export function SettingsList({ entries }: { entries: readonly SettingsEntry[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid="newquip-settings-list">
      {entries.map((e) => (
        <li key={e.href}>
          <Link href={e.href} className="group flex h-full items-start gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow-md focus-visible:border-indigo-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700 transition group-hover:bg-indigo-100"><NqIcon name={ICONS[e.href] ?? "settings"} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold text-slate-900 group-hover:text-indigo-800">{e.label}</span>
              <span className="mt-1 block text-sm text-slate-700">{e.description}</span>
            </span>
            <NqIcon name="chevron" className="mt-1 h-4 w-4 shrink-0 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-indigo-700" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

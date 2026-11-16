import Link from "next/link";
import { Panel } from "@/components/ui/Panel";
import type { SettingsEntry } from "@/newquip/settings-entries";

export function SettingsList({ entries }: { entries: readonly SettingsEntry[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid="newquip-settings-list">
      {entries.map((e) => (
        <li key={e.href}>
          <Link href={e.href} className="block h-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
            <Panel className="h-full transition hover:border-slate-300 hover:shadow-md">
              <p className="text-base font-semibold text-indigo-800">{e.label}</p>
              <p className="mt-1 text-sm text-slate-700">{e.description}</p>
            </Panel>
          </Link>
        </li>
      ))}
    </ul>
  );
}

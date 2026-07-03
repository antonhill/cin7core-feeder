"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/import", label: "Import & Sync" },
  { href: "/settings/instances", label: "Cin7 Instances" },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-6 border-b px-6 py-3">
      <Link href="/" className="text-sm font-semibold">
        Cin7 Feeder
      </Link>
      {LINKS.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`text-sm ${active ? "font-medium underline" : "text-gray-500 hover:text-black"}`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

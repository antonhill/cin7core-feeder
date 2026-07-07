import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppNav } from "./AppNav";
import { getCurrentUserInfo } from "@/actions/auth";
import { clearImpersonatedOrgAction } from "@/actions/org-switch";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cin7 Core Toolbox",
  description: "Do amazing things that you cannot do in Cin7 Core",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { email, isSuperAdmin, orgId, orgName, orgLogoUrl, isImpersonating, disabledModules } = await getCurrentUserInfo();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-full min-h-screen flex-row">
        <AppNav
          userEmail={email}
          isSuperAdmin={isSuperAdmin}
          orgId={orgId}
          orgName={orgName}
          orgLogoUrl={orgLogoUrl}
          disabledModules={disabledModules}
        />
        <div className="flex flex-1 flex-col overflow-y-auto">
          {isImpersonating && (
            <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-2 text-sm font-semibold text-white">
              <span>Viewing as {orgName ?? "another organization"} (master user)</span>
              <form action={clearImpersonatedOrgAction}>
                <button type="submit" className="rounded-full border border-white/60 px-3 py-0.5 text-xs font-semibold hover:bg-white/10">
                  Exit
                </button>
              </form>
            </div>
          )}
          {children}
        </div>
      </body>
    </html>
  );
}

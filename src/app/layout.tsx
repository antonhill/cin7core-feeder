import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppNav } from "./AppNav";
import TourGuide from "./tour-guide";
import { getCurrentUserInfo } from "@/actions/auth";
import { clearImpersonatedOrgAction } from "@/actions/org-switch";
import { checkoutAvailableFor } from "@/lib/billing";
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
  // The bare favicon itself is the file-convention src/app/icon.svg (a copy
  // of the same brand kit's icon.svg) — these cover the sizes/formats that
  // convention alone doesn't (explicit pixel favicons, iOS home-screen, PWA
  // manifest icons). See public/marketing/branding/README.txt.
  icons: {
    icon: [
      { url: "/marketing/branding/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/marketing/branding/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/marketing/branding/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/marketing/branding/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/marketing/branding/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/marketing/branding/apple-touch-icon.png",
  },
};

/** Outside the component body — Date.now() is an impure call the react-hooks/purity rule flags if made directly during render. */
function daysUntil(dateIso: string): number {
  return Math.max(0, Math.ceil((new Date(dateIso).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { email, isSuperAdmin, isOrgAdmin, orgId, orgName, orgLogoUrl, isImpersonating, disabledModules, subscriptionStatus, trialEndsAt } =
    await getCurrentUserInfo();

  const trialDaysLeft = subscriptionStatus === "trialing" && trialEndsAt ? daysUntil(trialEndsAt) : null;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-full min-h-screen flex-row">
        {email && (
          <AppNav
            key={orgId}
            userEmail={email}
            isSuperAdmin={isSuperAdmin}
            isOrgAdmin={isOrgAdmin}
            orgId={orgId}
            orgName={orgName}
            orgLogoUrl={orgLogoUrl}
            disabledModules={disabledModules}
            showBilling={checkoutAvailableFor(subscriptionStatus)}
          />
        )}
        <div className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto">
          {isImpersonating && (
            <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-2 text-sm font-semibold text-white print:hidden">
              <span>Viewing as {orgName ?? "another organization"} (master user)</span>
              <form action={clearImpersonatedOrgAction}>
                <button type="submit" className="rounded-full border border-white/60 px-3 py-0.5 text-xs font-semibold hover:bg-white/10">
                  Exit
                </button>
              </form>
            </div>
          )}
          {trialDaysLeft !== null && (
            <div className="bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-900 print:hidden">
              Trial — {trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"} left. Connect 1 instance, read-only until you subscribe.
            </div>
          )}
          {children}
        </div>
        {orgId && <TourGuide orgId={orgId} disabledModules={disabledModules} />}
      </body>
    </html>
  );
}

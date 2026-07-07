import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppNav } from "./AppNav";
import { getCurrentUserInfo } from "@/actions/auth";
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
  const { email, isSuperAdmin, orgName, orgLogoUrl, disabledModules } = await getCurrentUserInfo();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-full min-h-screen flex-row">
        <AppNav
          userEmail={email}
          isSuperAdmin={isSuperAdmin}
          orgName={orgName}
          orgLogoUrl={orgLogoUrl}
          disabledModules={disabledModules}
        />
        <div className="flex flex-1 flex-col overflow-y-auto">{children}</div>
      </body>
    </html>
  );
}

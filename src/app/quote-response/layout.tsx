import type { Metadata } from "next";

// The customer response page: never indexed, and no Referer is ever sent from it (the response token is not in the URL path or query, but nothing here should leak even the address).
export const metadata: Metadata = {
  title: "Secure quotation response",
  description: "Review and respond to your quotation.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
  // Not the Toolbox favicons of the root layout: a neutral NewQuip mark, inline so nothing else is requested.
  icons: { icon: [{ url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231e3a5f'/%3E%3Cpath d='M20 46V18h6l12 19V18h6v28h-6L26 27v19z' fill='%23fff'/%3E%3C/svg%3E", type: "image/svg+xml" }], apple: [] },
};

export default function QuoteResponseLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

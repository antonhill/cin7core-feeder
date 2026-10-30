import type { Metadata } from "next";

// The customer response page: never indexed, and no Referer is ever sent from it (the response token is not in the URL path or query, but nothing here should leak even the address).
export const metadata: Metadata = {
  title: "Quotation response",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function QuoteResponseLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

import "./globals.css";
import { Nav } from "../components/Nav";

export const metadata = { title: "RWTSA demonstration (local)" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground">
        <Nav />
        <main className="mx-auto max-w-5xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}

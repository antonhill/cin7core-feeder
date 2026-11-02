/**
 * The one page-width policy for NewQuip pages (was a copy-pasted `mx-auto w-full max-w-[...] px-6 py-N` string on every page).
 * `data` — operational tables and workspaces: up to 1920px. `wide` — configurators mixing forms and tables: 1480px.
 * `form` — forms and settings: 1200px, a comfortable reading width.
 */
export type PageWidth = "data" | "wide" | "form";

const WIDTH: Record<PageWidth, string> = {
  data: "max-w-[1920px]",
  wide: "max-w-[1480px]",
  form: "max-w-[1200px]",
};

export function pageContainerClass(width: PageWidth, density: "roomy" | "compact" = "roomy"): string {
  return `mx-auto w-full ${WIDTH[width]} px-4 md:px-6 ${density === "roomy" ? "py-8 md:py-10" : "py-6 md:py-8"}`;
}

export function PageContainer({
  width = "data",
  density = "roomy",
  className = "",
  children,
  ...rest
}: { width?: PageWidth; density?: "roomy" | "compact"; className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <main {...rest} className={`${pageContainerClass(width, density)} ${className}`.trim()}>
      {children}
    </main>
  );
}

/**
 * Thousands-separated formatting for numbers that appear in **error and limit
 * messages produced on the server**.
 *
 * `Number.prototype.toLocaleString()` with no locale argument uses the host's
 * default locale. In the browser that is the viewer's own locale, which is
 * exactly what UI display formatting wants — so the page components keep using
 * it. But these messages are built on the server, where "the host's locale" is
 * a property of whichever machine happened to serve the request: a Vercel
 * container, a CI runner, and a developer's laptop can all disagree. The same
 * limit error then reads "10,000" for one user and "10 000" (a non-breaking
 * space, en-ZA among others) for another, for no reason either of them can see.
 *
 * This surfaced as seven tests that passed in CI and failed on a South African
 * developer's machine — the assertions were correct and the source was
 * ambient. Pinning the locale here makes the message text a property of the
 * code rather than of the machine.
 *
 * `en-US` is chosen only because a comma is what these messages have always
 * rendered as in CI and in production, so nothing user-visible changes.
 *
 * ALSO used, deliberately, by the dashboard (`src/app/page.tsx`). That is a
 * Server Component, so its KPI counts are rendered into the initial HTML with
 * whatever locale the serving machine has — the same ambient-locale problem in a
 * display context rather than a message one. Pinning the separator there keeps
 * the server-rendered markup deterministic and hydration-safe. Note this is a
 * choice about a thousands separator only: the dashboard's *timestamp* is a
 * different question and is rendered in the viewer's own locale and timezone by
 * `src/app/local-timestamp.tsx`, because a wrong timezone is a wrong value, not
 * a formatting preference.
 */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

import Link from "next/link";

/**
 * Public, unauthenticated route (see PUBLIC_PATHS in middleware.ts) — client-
 * facing rendering of docs/legal/privacy-policy.md. Deliberately a separate
 * copy rather than rendering the markdown file directly: the .md file is the
 * internal working draft for attorney review and contains bracketed
 * to-do/placeholder notes that read as unfinished TODOs, not something a
 * client should see. Keep this page's wording in sync with the .md file's
 * substance when either changes; the .md file remains the source of truth
 * for anything not yet decided (retention period, cross-border transfer
 * justification, etc — this page phrases those honestly as "still being
 * finalized" instead of showing the internal placeholder text).
 */
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Draft — pending legal review.</strong> This policy is being finalized and hasn&rsquo;t yet been
        reviewed by an attorney. If you have questions about how your data is handled in the meantime, contact{" "}
        <a href="mailto:anton@sparkconsulting.co.za" className="underline">
          anton@sparkconsulting.co.za
        </a>
        .
      </div>

      <h1 className="mt-6 text-3xl font-bold tracking-tight text-slate-900">Privacy Policy</h1>
      <p className="mt-1 text-sm text-slate-500">Cin7 Core Toolbox — operated by Spark Consulting</p>

      <div className="mt-8 flex flex-col gap-6 text-base leading-relaxed text-slate-700">
        <section>
          <h2 className="text-lg font-semibold text-slate-900">1. Who we are</h2>
          <p className="mt-2">
            Cin7 Core Toolbox (&ldquo;the App&rdquo;) is operated by Spark Consulting, based in South Africa. This
            policy is written primarily to comply with South Africa&rsquo;s Protection of Personal Information Act
            (POPIA). If a client&rsquo;s own data processed through the App includes personal information of
            individuals in the European Union or United Kingdom, the GDPR/UK GDPR may also apply to that data — see
            section 8.
          </p>
          <p className="mt-2">Contact for privacy matters: anton@sparkconsulting.co.za.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">2. What the App does</h2>
          <p className="mt-2">
            The App connects to a client&rsquo;s own Cin7 Core account(s) to help the client import, validate, audit,
            migrate, and report on their own inventory, sales, and product data. Clients provide their own Cin7 API
            credentials; the App uses those credentials only to act on the client&rsquo;s Cin7 account, at the
            client&rsquo;s direction.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">3. What information we process</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>
              <strong>Account data</strong> — your name/email, used for login (one-time email code — we don&rsquo;t
              store passwords) and to identify who performed which action.
            </li>
            <li>
              <strong>Organization data</strong> — the organization(s) you belong to, and which App features are
              enabled for your organization.
            </li>
            <li>
              <strong>Cin7 credentials</strong> — your Cin7 Core account ID and application key, encrypted at rest
              (AES-256-GCM) before storage, decrypted only in server memory when making a request to Cin7 on your
              behalf. Never stored or logged in plaintext.
            </li>
            <li>
              <strong>Your Cin7 business data</strong> — product, sales, purchase, assembly/production, customer, and
              supplier records you import or that the App pulls live from your connected Cin7 instance(s). This may
              include personal information about your own customers or suppliers if present in your Cin7 data.
            </li>
            <li>
              <strong>Activity log</strong> — a record of every write the App makes back to your Cin7 instance(s):
              what changed, which user triggered it, and when.
            </li>
            <li>
              <strong>Basic technical logs</strong> — standard hosting-provider request logs, used only to operate
              and debug the App.
            </li>
          </ul>
          <p className="mt-2">We do not sell personal information, and we don&rsquo;t use client data for advertising.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">4. Why we process it</h2>
          <p className="mt-2">
            Processing is necessary to perform the service you&rsquo;ve engaged Spark Consulting to provide. Where
            your own Cin7 data contains personal information about your customers or suppliers, you remain the
            responsible party for that data under POPIA/GDPR, and Spark Consulting acts on your behalf — see our Data
            Processing Agreement.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">5. Where data is stored and processed</h2>
          <p className="mt-2">
            Application hosting is provided by Vercel; the primary database is Supabase (Postgres), currently hosted
            in the Ireland (eu-west-1) region. This means data may be processed outside South Africa.{" "}
            <strong>The precise cross-border-transfer basis is still being finalized</strong> and will be published
            here once confirmed — if this matters for your specific engagement, contact us before relying on this
            page.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">6. Data isolation between organizations</h2>
          <p className="mt-2">
            The App is multi-tenant: multiple organizations use the same underlying database, but database-level
            access rules enforce that a user can only ever query their own organization&rsquo;s data.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">7. Retention and deletion</h2>
          <p className="mt-2">
            <strong>Our specific retention commitment is still being finalized.</strong> As things stand, data is
            retained for the duration of your engagement with Spark Consulting and deleted on request afterward.
            Contact us if you need a specific commitment in writing for your organization.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">8. GDPR</h2>
          <p className="mt-2">
            This section only applies if your own Cin7 data includes personal information of individuals located in
            the EU/UK. In that case, you remain the data controller for that information, and our Data Processing
            Agreement is intended to serve as the Article 28 processor terms. Contact us if this applies to you.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">9. Your rights</h2>
          <p className="mt-2">
            Under POPIA, you (or, where applicable, individuals whose personal information appears in your Cin7 data)
            have the right to request access to, correction of, or deletion of personal information held about you,
            subject to POPIA&rsquo;s exceptions. To exercise these rights, contact anton@sparkconsulting.co.za.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">10. Security</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Cin7 credentials are encrypted at rest (AES-256-GCM) and never logged in plaintext.</li>
            <li>Login uses a one-time email code rather than a password, with optional two-factor authentication.</li>
            <li>Database access is enforced per-organization at the database level.</li>
            <li>All writes the App makes to your Cin7 instance are recorded in an auditable activity log.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">11. Sub-processors</h2>
          <p className="mt-2">
            We use Vercel (hosting) and Supabase (database, authentication) to provide the App. Your own Cin7 Core
            account is not a sub-processor — it&rsquo;s your pre-existing system that this App connects to at your
            direction, using credentials you supply.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900">12. Changes to this policy</h2>
          <p className="mt-2">
            We&rsquo;ll notify registered users by email of material changes to this policy before they take effect.
          </p>
        </section>
      </div>

      <p className="mt-10 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <Link href="/login" className="text-indigo-600 hover:underline">
          ← Back to sign in
        </Link>
      </p>
    </main>
  );
}

-- Quotation module: shipping / additional-charge margin treatment.
--
-- A charge (shipping, delivery, handling, …) is EXCLUDED from the estimated margin by default — an
-- unknown charge cost must never masquerade as 100% margin. The user can deliberately INCLUDE a
-- charge in the margin by entering an estimated cost (stored in quote_lines.average_cost, the same
-- cost-basis column product lines use; the entered value is preserved even while excluded so
-- toggling doesn't lose it — the margin only counts it when margin_included is true).
--
--   quote_lines.margin_included — per line, whether it counts toward the margin. Products: true.
--     Charges: the Exclude/Include choice (default false = excluded, the conservative default).
--   quotes.margin_scope — per quote, whether the headline margin covers everything ('overall') or is
--     products-only because at least one revenue-bearing charge was deliberately excluded
--     ('products_only'). Drives the summary label ("Estimated margin (shipping excluded)").
--
-- Both additive with safe defaults; existing rows keep the current behaviour (charges excluded).

alter table quote_lines add column if not exists margin_included boolean not null default false;
alter table quotes add column if not exists margin_scope text not null default 'overall';

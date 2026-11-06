-- 0120: partial progress-claim amounts (UAT-013).
--
-- Until now a claim line always claimed everything currently claimable on its stage, and a table CHECK enforced
--     current_claim_cents = earned_to_date_cents - previously_committed_cents.
-- A partial claim claims LESS than that maximum, so the equality is relaxed ONLY for lines explicitly flagged `partial`:
--     partial = false  ->  current = earned - previously committed          (unchanged: every existing row)
--     partial = true   ->  0 < current < earned - previously committed       (strictly below the maximum)
-- Everything else is untouched: previously_committed + current <= stage value, the frozen-lines trigger, the reservation/staleness check on
-- approval (it compares previously_committed with what other reserving claims hold, which does not depend on `earned`), RLS and grants.
-- The remainder of a partially claimed stage simply stays claimable by a later claim.
-- Additive and idempotent. Existing rows keep partial = false and satisfy the first branch exactly as before.

alter table project_claim_lines add column if not exists partial boolean not null default false;

-- Drop the old equality CHECK by its definition (it was created inline and unnamed, so its generated name is not relied on).
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.project_claim_lines'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%current_claim_cents = (earned_to_date_cents - previously_committed_cents)%'
  loop
    execute format('alter table project_claim_lines drop constraint %I', c.conname);
  end loop;
end $$;

alter table project_claim_lines drop constraint if exists project_claim_lines_amount_rule;
alter table project_claim_lines add constraint project_claim_lines_amount_rule check (
  (not partial and current_claim_cents = earned_to_date_cents - previously_committed_cents)
  or (partial and current_claim_cents > 0 and current_claim_cents < earned_to_date_cents - previously_committed_cents)
);

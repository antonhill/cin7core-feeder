-- 0128: a separate, nullable credential column for an independent NewQuip UAT deployment.
--
-- The UAT deployment runs with its OWN ENCRYPTION_KEY and CIN7_CREDENTIAL_STORE=uat, and reads/writes only this column. The existing
-- application_key_encrypted (sealed with the Toolbox key) is neither read, rewritten nor invalidated by it. Additive and idempotent; no data changes.
-- Same table, same RLS/grants: no new exposure beyond what application_key_encrypted already has.
alter table cin7_instances add column if not exists application_key_encrypted_uat text;

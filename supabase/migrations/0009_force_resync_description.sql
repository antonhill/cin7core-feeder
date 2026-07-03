-- Description was captured on import and already included in content_hash
-- (since the very first migration), but was never actually included in the
-- push payload — a mismatch between "the hash says this changed" and "this
-- was actually pushed" that a normal content_hash bump can't fix, since
-- description's value itself hasn't changed. Clear synced_hash so the next
-- sync run treats every product as changed and re-pushes it with the
-- now-corrected payload (idempotent — Cin7's own state converges to the
-- correct value either way, this just forces the one-time re-push).
update sync_state set synced_hash = null;

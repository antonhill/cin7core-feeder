// Test stub for the `server-only` package. That package throws when imported outside a
// React Server Component graph (its whole point), which would blow up any Vitest module
// that transitively imports a "server-only" file. Vitest aliases `server-only` to this
// no-op so those modules can be unit-tested. Production/Next builds still use the real
// package, so the server-only guarantee is unaffected.
export {};

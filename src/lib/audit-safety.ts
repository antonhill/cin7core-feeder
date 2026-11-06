// Defence in depth for anything persisted into a table that organisation members can read (activity_log): an audit detail must never carry a secret, whatever a caller passes in.
// The PRIMARY control is that callers log explicit, named fields only (never a whole environment or request object); this guard exists so one future mistake cannot leak a
// credential. Pure; no I/O. It redacts (1) any value equal to / containing a secret-named environment variable's value, (2) JWT-shaped strings, and (3) environment-shaped objects.
export const REDACTED = "[REDACTED]";
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|JWT|AUTH|DSN|CONNECTION_STRING)/i;
// Names of DETAIL keys that denote a credential (narrower than SECRET_NAME on purpose: `idempotencyKey`, `dedupeKey` and `tokenValidation` are legitimate evidence).
const SECRET_KEY_NAME = /(secret|password|passwd|credential|private_?key|api_?key|service_?role|access_?token|auth_?token|bearer)/i;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
const MIN_SECRET_LENGTH = 8;

type Env = Readonly<Record<string, string | undefined>>;

/** The values of secret-named variables worth scanning for (short values are skipped: they would redact ordinary words). */
function secretValues(env: Env): string[] {
  return Object.entries(env).filter(([k, v]) => SECRET_NAME.test(k) && typeof v === "string" && v.length >= MIN_SECRET_LENGTH).map(([, v]) => v as string);
}
/** An object that looks like a copy of process.env: several SHOUTY_SNAKE_CASE keys with string values. */
function looksLikeEnvironment(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o);
  return keys.length >= 4 && keys.filter((k) => ENV_NAME.test(k) && (typeof o[k] === "string" || o[k] === undefined)).length >= Math.ceil(keys.length * 0.8);
}

export function redactSecrets<T>(value: T, env: Env = process.env): T {
  const secrets = secretValues(env);
  const clean = (v: unknown, depth: number): unknown => {
    if (depth > 8) return REDACTED;
    if (typeof v === "string") {
      let out = v.replace(JWT_SHAPE, REDACTED);
      for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (looksLikeEnvironment(o)) return `${REDACTED} (environment-like object)`;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, SECRET_KEY_NAME.test(k) && typeof x === "string" && x.length >= MIN_SECRET_LENGTH ? REDACTED : clean(x, depth + 1)]));
    }
    return v;
  };
  return clean(value, 0) as T;
}

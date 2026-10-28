// The single, pure decision for "are Cin7 writes enabled on THIS deployment". Used by every Cin7-writing Server Action.
//
//  * OFF unless NEWQUIP_CIN7_WRITES_ENABLED is exactly the string "true" (any other value, including "TRUE", "1", "yes", is OFF).
//  * ALWAYS OFF on Production (VERCEL_ENV === "production") whatever the variable says: Production writes stay disabled until the owner
//    changes this code in a reviewed release, not by flipping a variable.
//  * On Preview it follows the variable, which Vercel can scope to a branch; with no variable set for the branch it is OFF.
export function cin7WritesEnabled(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.NEWQUIP_CIN7_WRITES_ENABLED === "true";
}

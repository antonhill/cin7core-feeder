// UAT-029: the Project details a manager may edit AFTER a project exists - the project manager, the start date and the target completion date. Nothing here touches the
// approved quotation, the contract value, the tax set-up, the stages or any claim: those are the frozen commercial baseline and have no edit path. Pure and database-free.

export interface ProjectDetailsInput { projectManager: string | null; startDate: string | null; targetCompletionDate: string | null }
export interface ProjectDetailsPatch { project_manager: string | null; start_date: string | null; target_completion_date: string | null }
export type ProjectDetailsResult = { ok: true; patch: ProjectDetailsPatch } | { ok: false; error: string };

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** A real calendar date written yyyy-mm-dd (so 2026-02-30 and 2026-13-01 are refused), within a sensible range. Empty means "not set". */
export function parseIsoDate(v: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  const t = (v ?? "").trim();
  if (t === "") return { ok: true, value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return { ok: false };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || y > MAX_YEAR) return { ok: false };
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { ok: false };
  return { ok: true, value: t };
}

/**
 * Validates an edit. `members` are the organisation's own users (lower-case emails): the project manager must be one of them, because a manager is a person who can
 * actually sign in and act on this project, not free text. Clearing the manager is allowed. The stored value is the member's canonical email.
 * `current` is the value already on the project: leaving it UNCHANGED is always allowed (a project created before this edit existed may carry free text such as a
 * fixture's name), so an admin can fix a date without being forced to change the manager. Only a NEW manager must be a user of the organisation.
 */
export function validateProjectDetails(input: ProjectDetailsInput, members: ReadonlyArray<string>, current: string | null = null): ProjectDetailsResult {
  for (const v of [input.projectManager, input.startDate, input.targetCompletionDate]) if (v !== null && v !== undefined && typeof v !== "string") return { ok: false, error: "The details must be text." };
  const start = parseIsoDate(input.startDate);
  if (!start.ok) return { ok: false, error: "The start date must be a real date (yyyy-mm-dd)." };
  const target = parseIsoDate(input.targetCompletionDate);
  if (!target.ok) return { ok: false, error: "The target completion date must be a real date (yyyy-mm-dd)." };
  if (start.value && target.value && target.value < start.value) return { ok: false, error: "The target completion date cannot be before the start date." };

  const wanted = (input.projectManager ?? "").trim().toLowerCase();
  let manager: string | null = null;
  if (wanted !== "" && current !== null && wanted === current.trim().toLowerCase()) {
    manager = current; // unchanged: kept exactly as recorded
  } else if (wanted !== "") {
    const hit = members.find((e) => e.toLowerCase() === wanted);
    if (!hit) return { ok: false, error: "The project manager must be a user of this organisation." };
    manager = hit.toLowerCase();
  }
  return { ok: true, patch: { project_manager: manager, start_date: start.value, target_completion_date: target.value } };
}

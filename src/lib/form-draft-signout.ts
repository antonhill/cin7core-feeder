import { clearAllDrafts, defaultDraftStorage } from "./form-draft";

/** Runs from the sign-out form's onSubmit (before the server action): a draft, which may hold cost overrides, must not outlive the session in this tab's sessionStorage. */
export function wipeDrafts(): void {
  clearAllDrafts(defaultDraftStorage());
}

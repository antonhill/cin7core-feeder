// Evidence upload limits and the browser file-picker filter. Free of server-only code so the Stage 5 form (a client component) and the server share ONE definition.
export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024; // per file, and also the TOTAL per upload: the hosting platform's route handlers accept a 4.5 MB request body in all
export const EVIDENCE_MAX_TOTAL = EVIDENCE_MAX_BYTES; // (more files can be added afterwards with "Add evidence")
export const EVIDENCE_MAX_FILES = 3;
export const EVIDENCE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.eml";

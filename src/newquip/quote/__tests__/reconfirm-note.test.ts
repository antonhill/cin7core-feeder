import { describe, expect, it } from "vitest";
import { COMPLETE_RECONFIRM_NOTE, INCOMPLETE_RECONFIRM_NOTE, reconfirmNote } from "../reconfirm-note";

describe("Price from Cin7: the reconfirmation sentence matches what the state machine actually does", () => {
  it("incomplete quotation: it stays in Estimator review; complete the pricing, then return it to the Rep before sign-off", () => {
    expect(reconfirmNote(2, true)).toBe("The quotation total has changed. Complete the remaining pricing and return it to the Rep for reconfirmation before sign-off.");
    expect(reconfirmNote(2, true)).toBe(INCOMPLETE_RECONFIRM_NOTE);
  });
  it("complete quotation: the existing automatic-return explanation is kept", () => {
    expect(reconfirmNote(1, false)).toBe(COMPLETE_RECONFIRM_NOTE);
    expect(COMPLETE_RECONFIRM_NOTE).toMatch(/returns to the Rep to reconfirm/);
  });
  it("nothing added: no sentence", () => { expect(reconfirmNote(0, true)).toBe(""); expect(reconfirmNote(0, false)).toBe(""); });
});

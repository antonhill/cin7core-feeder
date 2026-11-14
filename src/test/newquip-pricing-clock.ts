import { afterAll, beforeAll, expect, vi } from "vitest";

// NewQuip supplier-pricing tests build their fixtures at a fixed instant (AT = 2026-11-12T08:00Z) but the finality gate judges rate freshness (24h spot limit) and forward-cover validity
// against the CURRENT clock. Without a fixed clock those tests pass for 24 hours after the fixture instant and then fail forever (found 2026-11-13). This setup file runs for every test file and
// freezes ONLY Date, ONLY for the NewQuip pricing tests; timers, promises and every other test keep the real clock.
const FIXED_NOW = "2026-11-12T10:00:00.000Z"; // two hours after the fixtures' AT: every fixture rate is fresh, every fixture contract is valid
const PRICING_TEST_PATH = /(^|\/)src\/(newquip\/pricing\/|lib\/newquip-quotes\/__tests__\/(pricing-|rate-attestation|estimator-pricing))/;

const testPath = (expect.getState().testPath ?? "").replace(/\\/g, "/");
if (PRICING_TEST_PATH.test(testPath)) {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIXED_NOW));
  });
  afterAll(() => {
    vi.useRealTimers();
  });
}

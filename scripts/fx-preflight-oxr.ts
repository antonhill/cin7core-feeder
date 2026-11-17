// Read-only FX preflight for the NewQuip acceptance test. Prints the Open Exchange Rates reading as JSON. Writes nothing.
// Run in an environment that already holds OPENEXCHANGERATES_APP_ID (the value is never printed):
//   npx tsx scripts/fx-preflight-oxr.ts
import { fetchOxrRates, OxrError } from "../src/newquip/pricing/fx/open-exchange-rates";

fetchOxrRates(process.env.OPENEXCHANGERATES_APP_ID ?? "")
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => { console.error(e instanceof OxrError ? `FX preflight refused: ${e.message}` : "FX preflight failed"); process.exit(1); });

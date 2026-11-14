import { BondStockView } from "../../components/BondStock";
import { getBondReport } from "../../lib/bond";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <BondStockView load={await getBondReport()} />;
}

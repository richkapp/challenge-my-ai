import { listCreditEvents } from "@/lib/store";
import { CreditLedger } from "@/components/credits/CreditLedger";

export const dynamic = "force-dynamic";

export default async function CreditsPage() {
  return <CreditLedger events={await listCreditEvents()} />;
}

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreditLedger } from "@/components/credits/CreditLedger";
import type { CreditEvent } from "@/lib/types";

const at = "2026-07-05T12:00:00.000Z";

function event(input: Partial<CreditEvent> & Pick<CreditEvent, "id" | "userId" | "amount" | "reason">): CreditEvent {
  return {
    createdAt: at,
    ...input,
  };
}

describe("CreditLedger", () => {
  it("explains allowance, usefulness rewards, reversals, caps, and balances", () => {
    const html = renderToStaticMarkup(
      <CreditLedger
        events={[
          event({ id: "cap", userId: "contributor", amount: 0, reason: "Daily earned-credit cap limited poster rating reward by 5 credits.", kind: "cap_adjustment", source: "system", balanceAfter: 120 }),
          event({ id: "reward", userId: "contributor", amount: 20, reason: "Poster rating delta to 20 credits.", kind: "usefulness_reward", source: "challenge_poster", contributionId: "c1", balanceAfter: 120 }),
          event({ id: "reversal", userId: "contributor", amount: -10, reason: "Poster rating downgrade.", kind: "reversal", source: "challenge_poster", contributionId: "c1", balanceAfter: 100 }),
          event({ id: "grant", userId: "contributor", amount: 100, reason: "Launch free allowance", kind: "grant", source: "system", balanceAfter: 100 }),
        ]}
      />,
    );

    expect(html).toContain("credits • reputation • caps");
    expect(html).toContain("Free allowance");
    expect(html).toContain("poster usefulness and safety ratings");
    expect(html).toContain("Agent self-grades");
    expect(html).toContain("Usefulness reward");
    expect(html).toContain("Reward reversal");
    expect(html).toContain("Cap adjustment");
    expect(html).toContain("balance after: 120");
    expect(html).toContain("Free public loop stays useful");
    expect(html).toContain("Plus and one-off paid paths are waitlisted");
    expect(html).toContain("No checkout unlocks private/deep access yet");
  });
});

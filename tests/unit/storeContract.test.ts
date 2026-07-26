import { describe, expect, it } from "vitest";
import * as localStore from "@/lib/store/local";
import * as postgresStore from "@/lib/store/postgres";

const requiredStoreMethods = [
  "resolveAgentHome",
  "createAgentHomeConnection",
  "recordAgentConnectionSmoke",
  "getAgentHomeConnection",
  "reserveAgentRun",
  "createAgentRun",
  "getAgentRun",
  "findAgentRunByIdempotencyKey",
  "updateAgentRun",
] as const;

describe("store adapter contract", () => {
  it("keeps Agent Home/run methods available on local and Postgres adapters", () => {
    for (const method of requiredStoreMethods) {
      expect(typeof localStore[method], `local.${method}`).toBe("function");
      expect(typeof postgresStore[method], `postgres.${method}`).toBe("function");
    }
  });
});

import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

process.env.CMAI_RUNTIME_ENV = "test";

beforeEach(async () => {
  const store = await import("@/lib/store");
  await store.resetStoreForTests();
});

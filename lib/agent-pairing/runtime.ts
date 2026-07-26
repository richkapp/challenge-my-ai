import { env, storeDriver } from "@/lib/config/env";
import { PairingService } from "@/lib/agent-pairing/service";
import { MemoryPairingStateBackend, PostgresPairingStateBackend } from "@/lib/agent-pairing/storage";
import { pairingTelemetrySinkFromEnvironment } from "@/lib/agent-pairing/telemetry";
import { createLocalAgentProtocolTransactionCoordinator } from "@/lib/store/local";

let overrideService: PairingService | undefined;
let localService: PairingService | undefined;
let postgresService: PairingService | undefined;

function createService(backend: MemoryPairingStateBackend | PostgresPairingStateBackend): PairingService {
  return new PairingService(backend, { telemetry: pairingTelemetrySinkFromEnvironment(process.env) });
}

export function platformPairingService(): PairingService {
  if (overrideService) return overrideService;
  if (storeDriver() === "postgres") {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for Postgres pairing persistence.");
    postgresService ??= createService(new PostgresPairingStateBackend(env.DATABASE_URL));
    return postgresService;
  }
  localService ??= createService(new MemoryPairingStateBackend({}, createLocalAgentProtocolTransactionCoordinator()));
  return localService;
}

export function setPlatformPairingServiceForTests(service?: PairingService): void {
  overrideService = service;
}

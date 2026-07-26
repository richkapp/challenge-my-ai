const productionBlockedConnectionKinds = new Set(["fake_dev", "test_fake"]);

export function isFakeOrDevAgentProvider(provider: string) {
  const normalized = provider.toLowerCase();
  return normalized === "local_fake"
    || normalized === "fake-provider"
    || normalized.startsWith("fake-")
    || normalized.startsWith("fake_")
    || normalized.includes("test_fake")
    || normalized.includes("test-fake");
}

export function isProductionBlockedAgentConnection(connection: { provider: string; connectionKind: string }) {
  return productionBlockedConnectionKinds.has(connection.connectionKind) || isFakeOrDevAgentProvider(connection.provider);
}

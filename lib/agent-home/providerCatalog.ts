import type { AgentConnectionKind, AgentProviderAuthClass, ContributionMode, ModelProvenanceVerificationStatus } from "@/lib/types";
import { normalContributionModes } from "@/lib/contributionModes";

export const supportedAgentProviders = ["local_fake", "openrouter", "anthropic", "claude_code", "openai", "codex", "google", "gemini", "xai", "mistral", "groq", "deepseek", "zai", "ollama", "custom"] as const;
export type SupportedAgentProvider = (typeof supportedAgentProviders)[number];

export const providerReadinessStates = ["dev_only", "live_broker_caller", "adapter_pending", "compliance_review", "deferred"] as const;
export type ProviderReadinessState = (typeof providerReadinessStates)[number];

export const providerSetupMechanisms = ["local_dev", "broker_provider_access", "wif_bearer", "oauth", "device_code", "codex_session", "claude_code_session", "connector"] as const;
export type ProviderSetupMechanism = (typeof providerSetupMechanisms)[number];

export type ProviderCatalogAuthSupport = {
  authClass: AgentProviderAuthClass;
  countsForMvpUserPlan: boolean;
  authSetupLabel: string;
  authReadinessCopy: string;
};

export type ProviderCatalogCompliance = {
  providerReadiness: ProviderReadinessState;
  setupMechanisms: ProviderSetupMechanism[];
  brokerCaller: {
    registered: boolean;
    status: "live" | "pending" | "blocked";
    smokeBehavior: "local_dev" | "credential_and_model_proxy" | "adapter_unavailable" | "compliance_blocked";
    credentialStorage: "broker_vault" | "none";
  };
  metadataMapping: {
    capturesReturnedModel: boolean;
    capturesProviderResponseId: boolean;
    verificationStatus: ModelProvenanceVerificationStatus;
  };
  complianceCopy: string;
  manualPasteFallbackCopy: string;
};

type ProviderCatalogEntryBase = {
  id: SupportedAgentProvider;
  label: string;
  connectionKind: AgentConnectionKind;
  defaultModel: string;
  allowedModels: string[];
  allowedRequestClasses: ContributionMode[];
  exactModelMetadata: boolean;
  metadataVerification: ModelProvenanceVerificationStatus;
  sandboxTrustLabel: string;
  setupInstructions: string;
  liveModelProxyCaller: boolean;
};

export type ProviderCatalogEntry = ProviderCatalogEntryBase & ProviderCatalogCompliance & ProviderCatalogAuthSupport;

const providerEntryBases: Record<SupportedAgentProvider, ProviderCatalogEntryBase> = {
  local_fake: {
    id: "local_fake",
    label: "Local fake provider",
    connectionKind: "fake_dev",
    defaultModel: "deterministic-demo-agent",
    allowedModels: ["deterministic-demo-agent"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandbox-recorded only; exact model metadata is not verified.",
    setupInstructions: "Development adapter: run a smoke test to prove the Agent Home path without live provider credentials.",
    liveModelProxyCaller: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    connectionKind: "provider_key",
    defaultModel: "openai/gpt-4.1-mini",
    allowedModels: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: true,
    metadataVerification: "metadata_verified",
    sandboxTrustLabel: "Sandboxed Hermes run can attach OpenRouter provider metadata when the broker proxy returns a matching response id/model.",
    setupInstructions: "Connect OpenRouter provider access for Run my Agent here. The credential is stored broker-side, used through one-run model-proxy grants, and never sent to challenge run cells.",
    liveModelProxyCaller: true,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    connectionKind: "provider_key",
    defaultModel: "claude-sonnet-4-20250514",
    allowedModels: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-haiku-20241022"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: true,
    metadataVerification: "metadata_verified",
    sandboxTrustLabel: "Sandboxed Hermes run can attach Anthropic Messages API response id/model metadata when the broker proxy returns it.",
    setupInstructions: "Connect Anthropic API access for Run my Agent here. The credential is stored broker-side, used through one-run model-proxy grants, and never sent to challenge run cells.",
    liveModelProxyCaller: true,
  },
  claude_code: {
    id: "claude_code",
    label: "Claude Code plan",
    connectionKind: "oauth",
    defaultModel: "sonnet",
    allowedModels: ["sonnet", "opus", "haiku"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Claude subscription auth runs through the official broker-side Claude Code CLI and a one-run execution mode. Exact model identity remains sandbox-recorded unless receipt-bound CLI output establishes it.",
    setupInstructions: "Use Connect Claude Code to complete Anthropic's official browser authorization once. Claude Code manages refreshes; every challenge still requires a fresh run approval.",
    liveModelProxyCaller: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI Responses API",
    connectionKind: "provider_key",
    defaultModel: "gpt-5.6-sol",
    allowedModels: ["gpt-5.6-sol", "gpt-5.4-mini", "gpt-4.1-mini"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: true,
    metadataVerification: "metadata_verified",
    sandboxTrustLabel: "Sandboxed Hermes run can attach OpenAI Responses API response id/model metadata when the broker proxy returns it.",
    setupInstructions: "Connect OpenAI API access for API-only model-proxy scaffolding. This is not Codex/ChatGPT plan auth and does not satisfy the normal-user MVP path.",
    liveModelProxyCaller: true,
  },
  codex: {
    id: "codex",
    label: "Codex / ChatGPT plan",
    connectionKind: "device_code",
    defaultModel: "gpt-5.6-sol",
    allowedModels: ["gpt-5.6-sol", "gpt-5.4-mini"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Codex ChatGPT plan auth runs through broker-held Codex-managed auth and a one-run execution mode. Exact model identity remains sandbox-recorded until Codex exposes receipt-bound metadata.",
    setupInstructions: "Use Connect Codex to complete OpenAI's device-login flow once. Codex securely manages refreshes; every challenge still requires a fresh run approval.",
    liveModelProxyCaller: true,
  },
  google: {
    id: "google",
    label: "Google Gemini",
    connectionKind: "provider_key",
    defaultModel: "gemini-2.5-flash",
    allowedModels: ["gemini-2.5-flash"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandboxed Hermes run supported after a Gemini broker adapter is configured; exact model metadata is not live yet.",
    setupInstructions: "Google/Gemini setup is reserved under Run my Agent here, but the broker-side provider caller is not enabled yet.",
    liveModelProxyCaller: false,
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    connectionKind: "provider_key",
    defaultModel: "gemini-2.5-flash",
    allowedModels: ["gemini-2.5-flash"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandboxed Hermes run supported after a Gemini broker adapter is configured; exact model metadata is not live yet.",
    setupInstructions: "Gemini setup is reserved under Run my Agent here, but the broker-side provider caller is not enabled yet.",
    liveModelProxyCaller: false,
  },
  xai: {
    id: "xai",
    label: "xAI",
    connectionKind: "provider_key",
    defaultModel: "grok-4",
    allowedModels: ["grok-4"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandboxed Hermes run supported after an xAI broker adapter is configured; exact model metadata is not live yet.",
    setupInstructions: "xAI setup is reserved under Run my Agent here, but the broker-side provider caller is not enabled yet.",
    liveModelProxyCaller: false,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    connectionKind: "provider_key",
    defaultModel: "mistral-large-latest",
    allowedModels: ["mistral-large-latest"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandboxed Hermes run supported after a Mistral broker adapter is configured; exact model metadata is not live yet.",
    setupInstructions: "Mistral setup is reserved under Run my Agent here, but the broker-side provider caller is not enabled yet.",
    liveModelProxyCaller: false,
  },
  groq: {
    id: "groq",
    label: "Groq",
    connectionKind: "provider_key",
    defaultModel: "llama-3.3-70b-versatile",
    allowedModels: ["llama-3.3-70b-versatile"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandboxed Hermes run supported after a Groq broker adapter is configured; exact model metadata is not live yet.",
    setupInstructions: "Groq setup is reserved under Run my Agent here, but the broker-side provider caller is not enabled yet.",
    liveModelProxyCaller: false,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    connectionKind: "provider_key",
    defaultModel: "deepseek-chat",
    allowedModels: ["deepseek-chat"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandboxed Hermes run supported after a DeepSeek broker adapter is configured; exact model metadata is not live yet.",
    setupInstructions: "DeepSeek setup is reserved under Run my Agent here, but the broker-side provider caller is not enabled yet.",
    liveModelProxyCaller: false,
  },
  zai: {
    id: "zai",
    label: "Z.ai",
    connectionKind: "provider_key",
    defaultModel: "glm-4.5",
    allowedModels: ["glm-4.5"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Sandboxed Hermes run supported after a Z.ai broker adapter is configured; exact model metadata is not live yet.",
    setupInstructions: "Z.ai setup is reserved under Run my Agent here, but the broker-side provider caller is not enabled yet.",
    liveModelProxyCaller: false,
  },
  ollama: {
    id: "ollama",
    label: "Ollama/local bridge",
    connectionKind: "connector",
    defaultModel: "local-model",
    allowedModels: ["local-model"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Local bridge setup is not a trusted production provider until it feeds the server-side broker receipt path.",
    setupInstructions: "Local bridge setup is deferred. It must still feed Run my Agent here through the server-side sandbox and receipt path.",
    liveModelProxyCaller: false,
  },
  custom: {
    id: "custom",
    label: "Custom provider",
    connectionKind: "connector",
    defaultModel: "custom-model",
    allowedModels: ["custom-model"],
    allowedRequestClasses: [...normalContributionModes],
    exactModelMetadata: false,
    metadataVerification: "sandbox_recorded",
    sandboxTrustLabel: "Custom providers require an approved broker adapter before trusted runs are enabled.",
    setupInstructions: "Custom provider setup is deferred until an approved broker adapter exists.",
    liveModelProxyCaller: false,
  },
};

const manualPasteFallbackCopy = "Manual paste remains available: copy the visible challenge prompt into your own Agent and paste back a CMAI_CONTRIBUTION_CARD_V1 card.";

const pendingBrokerCopy = (label: string) => `${label} is recognized as an Agent Home setup target, but trusted runs wait for a provider-specific broker caller, smoke behavior, metadata mapping, and tests.`;

const providerCompliance: Record<SupportedAgentProvider, ProviderCatalogCompliance> = {
  local_fake: {
    providerReadiness: "dev_only",
    setupMechanisms: ["local_dev"],
    brokerCaller: { registered: true, status: "live", smokeBehavior: "local_dev", credentialStorage: "none" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: "Development-only fake provider for proving Agent Home mechanics. It must not be treated as production provider proof.",
    manualPasteFallbackCopy,
  },
  openrouter: {
    providerReadiness: "live_broker_caller",
    setupMechanisms: ["broker_provider_access"],
    brokerCaller: { registered: true, status: "live", smokeBehavior: "credential_and_model_proxy", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: true, capturesProviderResponseId: true, verificationStatus: "metadata_verified" },
    complianceCopy: "OpenRouter is live only as a broker-side one-run model proxy under Run my Agent here. Provider access stays in the broker vault and provider metadata is broker-captured, not provider-signed proof.",
    manualPasteFallbackCopy,
  },
  anthropic: {
    providerReadiness: "live_broker_caller",
    setupMechanisms: ["broker_provider_access", "wif_bearer"],
    brokerCaller: { registered: true, status: "live", smokeBehavior: "credential_and_model_proxy", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: true, capturesProviderResponseId: true, verificationStatus: "metadata_verified" },
    complianceCopy: "Anthropic is live only through the broker-held Messages API caller under Run my Agent here. Provider access or WIF bearer tokens never enter child run config; response id/model metadata is broker-captured and receipt-bound, not provider-signed proof.",
    manualPasteFallbackCopy,
  },
  claude_code: {
    providerReadiness: "live_broker_caller",
    setupMechanisms: ["oauth", "claude_code_session"],
    brokerCaller: { registered: true, status: "live", smokeBehavior: "credential_and_model_proxy", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: true, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: "Claude Code plan auth uses Anthropic's official CLI as a broker-side one-run execution backend. Managed credential state stays in the broker vault; child run cells receive only scoped delegation metadata and the broker URL. This technical path is not represented as Anthropic approval for hosted third-party subscription routing.",
    manualPasteFallbackCopy,
  },
  openai: {
    providerReadiness: "live_broker_caller",
    setupMechanisms: ["broker_provider_access", "wif_bearer"],
    brokerCaller: { registered: true, status: "live", smokeBehavior: "credential_and_model_proxy", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: true, capturesProviderResponseId: true, verificationStatus: "metadata_verified" },
    complianceCopy: "OpenAI Responses API is live only as an API-only broker-side caller. API keys or WIF bearer tokens stay in the broker vault; this is not Codex/ChatGPT subscription/device-code auth and must not count as normal-user plan readiness.",
    manualPasteFallbackCopy,
  },
  codex: {
    providerReadiness: "live_broker_caller",
    setupMechanisms: ["device_code", "codex_session"],
    brokerCaller: { registered: true, status: "live", smokeBehavior: "credential_and_model_proxy", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: "Codex/ChatGPT plan auth uses a broker-side one-run Codex session execution mode. Session material stays in the broker vault; child run cells receive only scoped delegation metadata and the broker URL. Do not substitute OpenAI API keys for this path.",
    manualPasteFallbackCopy,
  },
  google: {
    providerReadiness: "compliance_review",
    setupMechanisms: ["broker_provider_access", "oauth"],
    brokerCaller: { registered: false, status: "blocked", smokeBehavior: "compliance_blocked", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: "Google/Gemini setup needs auth-key/OAuth consent and production credential handling decisions before trusted runs are enabled.",
    manualPasteFallbackCopy,
  },
  gemini: {
    providerReadiness: "compliance_review",
    setupMechanisms: ["broker_provider_access", "oauth"],
    brokerCaller: { registered: false, status: "blocked", smokeBehavior: "compliance_blocked", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: "Gemini remains fail-closed until auth-key migration, OAuth consent, and broker-side credential handling are represented safely.",
    manualPasteFallbackCopy,
  },
  xai: {
    providerReadiness: "adapter_pending",
    setupMechanisms: ["broker_provider_access"],
    brokerCaller: { registered: false, status: "pending", smokeBehavior: "adapter_unavailable", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: pendingBrokerCopy("xAI"),
    manualPasteFallbackCopy,
  },
  mistral: {
    providerReadiness: "adapter_pending",
    setupMechanisms: ["broker_provider_access"],
    brokerCaller: { registered: false, status: "pending", smokeBehavior: "adapter_unavailable", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: pendingBrokerCopy("Mistral"),
    manualPasteFallbackCopy,
  },
  groq: {
    providerReadiness: "adapter_pending",
    setupMechanisms: ["broker_provider_access"],
    brokerCaller: { registered: false, status: "pending", smokeBehavior: "adapter_unavailable", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: pendingBrokerCopy("Groq"),
    manualPasteFallbackCopy,
  },
  deepseek: {
    providerReadiness: "adapter_pending",
    setupMechanisms: ["broker_provider_access"],
    brokerCaller: { registered: false, status: "pending", smokeBehavior: "adapter_unavailable", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: pendingBrokerCopy("DeepSeek"),
    manualPasteFallbackCopy,
  },
  zai: {
    providerReadiness: "adapter_pending",
    setupMechanisms: ["broker_provider_access"],
    brokerCaller: { registered: false, status: "pending", smokeBehavior: "adapter_unavailable", credentialStorage: "broker_vault" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: pendingBrokerCopy("Z.ai"),
    manualPasteFallbackCopy,
  },
  ollama: {
    providerReadiness: "deferred",
    setupMechanisms: ["connector"],
    brokerCaller: { registered: false, status: "pending", smokeBehavior: "adapter_unavailable", credentialStorage: "none" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: "Local bridge support is deferred until it feeds the server-side broker, sandbox, and receipt path without becoming a client-side proof lane.",
    manualPasteFallbackCopy,
  },
  custom: {
    providerReadiness: "deferred",
    setupMechanisms: ["connector"],
    brokerCaller: { registered: false, status: "pending", smokeBehavior: "adapter_unavailable", credentialStorage: "none" },
    metadataMapping: { capturesReturnedModel: false, capturesProviderResponseId: false, verificationStatus: "sandbox_recorded" },
    complianceCopy: "Custom providers need an approved broker adapter, smoke behavior, metadata mapping, and tests before trusted runs are enabled.",
    manualPasteFallbackCopy,
  },
};

const providerAuthSupport: Record<SupportedAgentProvider, ProviderCatalogAuthSupport> = {
  local_fake: {
    authClass: "manual_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "Development-only fake provider",
    authReadinessCopy: "Local fake runs are allowed only for development proof paths and never count as production user-plan auth.",
  },
  openrouter: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "API-only model-proxy scaffold",
    authReadinessCopy: "OpenRouter uses broker-held API access. It can prove model-proxy mechanics, but it is not normal-user plan auth for the MVP.",
  },
  anthropic: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "Anthropic API-only scaffold",
    authReadinessCopy: "Anthropic Messages API access remains API-only broker scaffolding. Claude plan access is a separate `claude_code` official-CLI path whose hosted third-party policy approval remains unresolved.",
  },
  claude_code: {
    authClass: "user_plan_oauth",
    countsForMvpUserPlan: true,
    authSetupLabel: "Official Claude Code subscription login",
    authReadinessCopy: "Claude Code counts as a normal-user subscription path only after official CLI login and broker smoke prove the one-run Claude Code execution path. The saved connection is reused; each challenge still requires approval. Hosted third-party policy approval is not implied.",
  },
  openai: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "OpenAI Responses API-only scaffold",
    authReadinessCopy: "OpenAI Responses API access is not Codex/ChatGPT subscription auth. Keep it separate from the Codex normal-user plan path.",
  },
  codex: {
    authClass: "device_auth",
    countsForMvpUserPlan: true,
    authSetupLabel: "Codex ChatGPT device login",
    authReadinessCopy: "Codex counts as the normal-user ChatGPT plan path after OpenAI device login and broker smoke prove the one-run Codex execution path. The saved connection is reused; each challenge still requires approval. Exact model identity remains sandbox-recorded until Codex exposes provider metadata.",
  },
  google: {
    authClass: "compliance_blocked",
    countsForMvpUserPlan: false,
    authSetupLabel: "Provider auth blocked pending consent review",
    authReadinessCopy: "Google/Gemini auth needs consent and production credential handling decisions before it can count as user-plan auth.",
  },
  gemini: {
    authClass: "compliance_blocked",
    countsForMvpUserPlan: false,
    authSetupLabel: "Provider auth blocked pending consent review",
    authReadinessCopy: "Gemini auth needs consent and production credential handling decisions before it can count as user-plan auth.",
  },
  xai: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "API adapter pending",
    authReadinessCopy: "xAI is not a normal-user plan auth path yet; adapter work remains pending.",
  },
  mistral: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "API adapter pending",
    authReadinessCopy: "Mistral is not a normal-user plan auth path yet; adapter work remains pending.",
  },
  groq: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "API adapter pending",
    authReadinessCopy: "Groq is not a normal-user plan auth path yet; adapter work remains pending.",
  },
  deepseek: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "API adapter pending",
    authReadinessCopy: "DeepSeek is not a normal-user plan auth path yet; adapter work remains pending.",
  },
  zai: {
    authClass: "api_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "API adapter pending",
    authReadinessCopy: "Z.ai is not a normal-user plan auth path yet; adapter work remains pending.",
  },
  ollama: {
    authClass: "manual_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "Local connector deferred",
    authReadinessCopy: "Local bridge setup is deferred and does not count as hosted normal-user plan auth.",
  },
  custom: {
    authClass: "manual_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "Custom connector deferred",
    authReadinessCopy: "Custom connectors need an approved broker adapter and auth contract before they can count as normal-user plan auth.",
  },
};

const providerEntries = Object.fromEntries(
  supportedAgentProviders.map((provider) => [provider, { ...providerEntryBases[provider], ...providerCompliance[provider], ...providerAuthSupport[provider] }]),
) as Record<SupportedAgentProvider, ProviderCatalogEntry>;

export function providerCatalogEntry(provider: string): ProviderCatalogEntry {
  const normalized = provider.toLowerCase();
  if (normalized === "local_fake"
    || normalized === "fake-provider"
    || normalized.startsWith("fake-")
    || normalized.startsWith("fake_")
    || normalized.includes("test_fake")
    || normalized.includes("test-fake")) return providerEntries.local_fake;
  return providerEntries[(provider as SupportedAgentProvider)] || providerEntries.custom;
}

export function providerCatalog(): ProviderCatalogEntry[] {
  return supportedAgentProviders.map((provider) => providerEntries[provider]);
}

import type {
  ChallengeCriteriaHistoryEntry,
  ChallengeCriteriaStatus,
  ChallengeIntent,
  ChallengeSuccessfulOutcome,
  DeclarativeRewardPosture,
} from "@/lib/challenges/intent";

export const contributionModes = ["critique", "red_team", "alternate_proposal", "steelman", "risk_audit", "judge"] as const;
export type ContributionMode = (typeof contributionModes)[number];

export const modelProvenanceSources = ["self_attested", "client_attested", "provider_api_verified", "hermes_sandbox_run", "platform_run", "provider_signed"] as const;
export type ModelProvenanceSource = (typeof modelProvenanceSources)[number];

export const modelFundingSources = ["self_attested", "user_funded", "platform_funded", "unknown", "user_provider_access", "external_user_subscription", "cmai_platform_later"] as const;
export type ModelFundingSource = (typeof modelFundingSources)[number];

export const modelExecutionAuthorities = ["contributor_claim", "cmai_broker", "provider", "user_external", "user_connector", "cmai_sandbox", "cmai_platform"] as const;
export type ModelExecutionAuthority = (typeof modelExecutionAuthorities)[number];

export const modelProvenanceEvidenceTypes = ["user_claim", "client_manifest", "hermes_run_receipt", "provider_metadata", "platform_run_record", "provider_signature"] as const;
export type ModelProvenanceEvidenceType = (typeof modelProvenanceEvidenceTypes)[number];

export const modelProvenanceVerificationStatuses = ["unverified", "attested", "sandbox_recorded", "metadata_verified", "platform_verified", "cryptographically_verified", "disputed", "revoked"] as const;
export type ModelProvenanceVerificationStatus = (typeof modelProvenanceVerificationStatuses)[number];

export const sandboxProviders = ["local_fake", "railway", "other"] as const;
export type SandboxProvider = (typeof sandboxProviders)[number];

export const sandboxNetworkIsolations = ["ISOLATED", "PRIVATE"] as const;
export type SandboxNetworkIsolation = (typeof sandboxNetworkIsolations)[number];

export const agentHomeSetupStatuses = ["setup_required", "ready"] as const;
export type AgentHomeSetupStatus = (typeof agentHomeSetupStatuses)[number];
export const agentHomeStatuses = agentHomeSetupStatuses;
export type AgentHomeStatus = AgentHomeSetupStatus;

export const agentConnectionKinds = ["fake_dev", "oauth", "device_code", "provider_key", "connector", "test_fake"] as const;
export type AgentConnectionKind = (typeof agentConnectionKinds)[number];
export const agentConnectionAuthModes = agentConnectionKinds;
export type AgentConnectionAuthMode = AgentConnectionKind;

export const agentConnectionStatuses = ["setup_required", "ready", "smoke_failed", "paused", "needs_reconnect", "expired", "revoked"] as const;
export type AgentConnectionStatus = (typeof agentConnectionStatuses)[number];

export const agentProviderAuthClasses = ["user_plan_oauth", "device_auth", "provider_approved_gateway", "api_only", "compliance_blocked", "manual_only"] as const;
export type AgentProviderAuthClass = (typeof agentProviderAuthClasses)[number];

export const agentRequestClasses = ["contribution_card", "challenge_contribution", "smoke_test", ...contributionModes] as const;
export type AgentRequestClass = (typeof agentRequestClasses)[number];

export const agentConnectionReadinessStates = ["setup_needed", "ready", "smoke_failed", "paused", "unavailable"] as const;
export type AgentConnectionReadinessState = (typeof agentConnectionReadinessStates)[number];

export const agentConnectionSmokeStatuses = ["not_run", "passed", "failed"] as const;
export type AgentConnectionSmokeStatus = (typeof agentConnectionSmokeStatuses)[number];
export const agentSmokeTestStatuses = agentConnectionSmokeStatuses;
export type AgentSmokeTestStatus = AgentConnectionSmokeStatus;

export type AgentConnectionSmokeResult = {
  status: AgentConnectionSmokeStatus;
  checkedAt?: string;
  message: string;
  failureCode?: string;
  redacted?: boolean;
};

export type AgentConnectionReadiness = {
  state: AgentConnectionReadinessState;
  label: string;
  detail: string;
  canRunHere: boolean;
};

export type AgentConnectionAuditEvent = {
  id: string;
  action: "created" | "credential_rotated" | "paused" | "resumed" | "revoked" | "smoke_passed" | "smoke_failed" | "reconnect_required";
  summary: string;
  createdAt: string;
  redacted?: boolean;
};

export type AgentConnection = {
  id: string;
  agentHomeId: string;
  ownerId: string;
  displayLabel: string;
  provider: string;
  providerLabel: string;
  connectionKind: AgentConnectionKind;
  status: AgentConnectionStatus;
  readiness: AgentConnectionReadiness;
  defaultModel: string;
  allowedModels: string[];
  allowedRequestClasses: ContributionMode[];
  metadataVerification: ModelProvenanceVerificationStatus;
  exactModelMetadata: boolean;
  sandboxTrustLabel: string;
  setupInstructions: string;
  liveModelProxyCaller: boolean;
  providerReadiness: string;
  authClass: AgentProviderAuthClass;
  countsForMvpUserPlan: boolean;
  authSetupLabel: string;
  authReadinessCopy: string;
  setupMechanisms: string[];
  complianceCopy: string;
  manualPasteFallbackCopy: string;
  brokerCredentialAvailable?: boolean;
  credentialUpdatedAt?: string;
  credentialRotatedAt?: string;
  credentialExpiresAt?: string;
  credentialPublicMetadata?: Record<string, string>;
  auditTrail?: AgentConnectionAuditEvent[];
  lastSmoke: AgentConnectionSmokeResult;
  createdAt: string;
  updatedAt: string;
};

export type AgentHome = {
  id: string;
  ownerId: string;
  ownerLabel: string;
  setupStatus: AgentHomeSetupStatus;
  connections: AgentConnection[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
};

export type AgentConnectionDelegation = {
  delegation_id?: string;
  connection_id: string;
  agent_connection_id?: string;
  provider: string;
  allowed_model?: string;
  allowed_request_class?: string;
  expires_at: string;
  max_spend_cents?: number;
  no_spend_reason?: string;
  max_requests?: number;
};

export type ModelProxyGrantRecord = {
  delegationId: string;
  runId: string;
  ownerId: string;
  agentConnectionId: string;
  provider: string;
  allowedModel: string;
  allowedRequestClass: string;
  expiresAt: string;
  maxRequests: number;
  remainingRequests: number;
  credentialRef: string;
  maxSpendCents?: number;
  createdAt: string;
  consumedAt?: string;
  revokedAt?: string;
  revokedReason?: string;
};

export const agentRunStatuses = ["queued", "preparing_delegation", "running_cell", "validating_artifacts", "contributed", "failed"] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];

export type OneRunDelegation = {
  id: string;
  agentHomeId: string;
  connectionId: string;
  challengeId: string;
  contributorId: string;
  requestedMode: ContributionMode;
  requestClass: string;
  status: "issued" | "consumed" | "revoked" | "expired";
  expiresAt: string;
  maxRequests: number;
  maxSpendCents?: number;
  noSpendLimitReason?: string;
  createdAt: string;
  consumedAt?: string;
  revokedAt?: string;
};

export type AgentRunReceiptSummary = {
  receiptId: string;
  receiptSha256: string;
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  networkIsolation: SandboxNetworkIsolation;
  teardownCompleted: boolean;
  teardownError?: string;
  provider: string;
  requestedModel: string;
  model: string;
  modelDisplayName: string;
  providerResponseId?: string;
  providerModelVerified: boolean;
  delegationId?: string;
};

export type AgentRunFailure = {
  code: string;
  message: string;
  failedAt: string;
};

export type AgentRun = {
  id: string;
  agentHomeId: string;
  connectionId: string;
  challengeId: string;
  contributorId: string;
  requestedMode: ContributionMode;
  requestedModel?: string;
  requestClass: string;
  status: AgentRunStatus;
  idempotencyKey?: string;
  jobId?: string;
  contributionId?: string;
  receiptSummary?: AgentRunReceiptSummary;
  failure?: AgentRunFailure;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  startedAt?: string;
  validatingAt?: string;
  contributedAt?: string;
  failedAt?: string;
};

export type AgentChildRunInput = {
  schemaVersion: "1.0";
  runId: string;
  challengeId: string;
  contributorId: string;
  agentHomeId: string;
  connectionId: string;
  contributionMode: ContributionMode;
  requestClass: string;
  provider: string;
  requestedModel: string;
  modelProxyUrl?: string;
  delegation: OneRunDelegation;
  challengeBundle: unknown;
  runner: {
    profile: string;
    checkpoint: string;
    command: string;
  };
  sandbox: {
    provider: SandboxProvider;
    networkIsolation: SandboxNetworkIsolation;
  };
  limits: {
    maxOutputBytes: number;
    timeoutSeconds: number;
  };
  issuedAt: string;
};

export type AgentHomeActivityAction = "home_created" | "connection_upserted" | "readiness_recorded" | "run_created" | "run_status_changed" | "run_contributed" | "run_failed";

export type AgentHomeActivity = {
  id: string;
  agentHomeId: string;
  ownerId: string;
  action: AgentHomeActivityAction;
  summary: string;
  connectionId?: string;
  runId?: string;
  challengeId?: string;
  contributionId?: string;
  createdAt: string;
};

export type ModelProvenance = {
  source: ModelProvenanceSource;
  provider: string;
  model: string;
  requested_model?: string;
  returned_model?: string;
  model_display_name: string;
  adapter: string;
  verified: boolean;
  provider_model_verified?: boolean;
  verification_notes: string;
  evidence_type?: ModelProvenanceEvidenceType;
  verification_status?: ModelProvenanceVerificationStatus;
  run_id?: string;
  receipt_id?: string;
  receipt_sha256?: string;
  delegation_id?: string;
  sandbox_id?: string;
  sandbox_provider?: SandboxProvider;
  sandbox_network_isolation?: SandboxNetworkIsolation;
  sandbox_teardown_completed?: boolean;
  funding_source?: ModelFundingSource;
  execution_authority?: ModelExecutionAuthority;
  agent_connection_id?: string;
  runner_profile?: string;
  runner_checkpoint?: string;
  provider_response_id?: string;
  artifact_sha256?: string;
  prompt_sha256?: string;
  output_sha256?: string;
  transcript_sha256?: string;
};

export type HermesRunReceiptSignature = {
  algorithm: "hmac-sha256";
  key_id: string;
  value: string;
};

export type HermesRunReceipt = {
  schema_version: "1.0";
  receipt_id: string;
  source: "hermes_sandbox_run";
  run_id: string;
  challenge_id: string;
  contributor_id: string;
  funding_source: ModelFundingSource;
  execution_authority: ModelExecutionAuthority;
  delegation?: AgentConnectionDelegation;
  provider: {
    provider: string;
    requested_model: string;
    returned_model?: string;
    model_display_name: string;
    provider_response_id?: string;
    provider_model_verified: boolean;
  };
  runner: {
    profile: string;
    checkpoint: string;
    hermes_version?: string;
    container_image_digest?: string;
  };
  sandbox: {
    provider: SandboxProvider;
    sandbox_id: string;
    network_isolation: SandboxNetworkIsolation;
    teardown_completed: boolean;
    teardown_error?: string;
  };
  tool_policy: string;
  network_policy: string;
  artifacts: {
    prompt_sha256: string;
    output_sha256: string;
    transcript_sha256: string;
    artifact_sha256?: string;
  };
  timing: {
    queued_at?: string;
    started_at: string;
    completed_at: string;
    duration_ms: number;
  };
  signature: HermesRunReceiptSignature;
};

export type SafetyFlag = "prompt_injection" | "malicious_code" | "unsafe_link" | "secret_exposure" | "privacy_risk" | "tool_use_request" | "sensitive_category";

export type ChallengePrivacySensitivity = "public_ok" | "anonymize_first" | "private_only" | "unknown";

export type CurrentUser = {
  id: string;
  name: string;
  role: "user" | "moderator";
  authSource: "local-dev" | "cookie" | "header" | "supabase";
};

export type ChallengeBrief = {
  schema_version: "1.0";
  challenge_semantics_version?: "1.0";
  challenge_intent?: ChallengeIntent;
  criteria_status?: ChallengeCriteriaStatus;
  criteria_version?: number;
  successful_outcomes?: ChallengeSuccessfulOutcome[];
  criteria_history?: ChallengeCriteriaHistoryEntry[];
  reward_posture?: DeclarativeRewardPosture;
  title: string;
  category: string;
  challenge_mode_requested: ContributionMode[];
  problem_statement: string;
  original_ai_answer: string;
  context: string;
  constraints: string[];
  success_criteria: string[];
  assumptions_to_test: string[];
  claims_to_check: string[];
  known_risks: string[];
  what_a_useful_response_should_address: string[];
  privacy_sensitivity: ChallengePrivacySensitivity;
  redactions_made: string[];
  abuse_or_safety_flags: string[];
  missing_information: string[];
  raw_material_summary: string;
};

export const challengePublicEligibilityReasons = [
  "not_public",
  "suppressed",
  "criteria_unconfirmed",
  "invalid_semantics",
  "private_only",
  "privacy_approval_missing",
  "unsafe_public_content",
  "quarantined",
] as const;

export type ChallengePublicEligibilityReason = (typeof challengePublicEligibilityReasons)[number];

export type ChallengePublicEligibility = {
  eligible: boolean;
  reasons: ChallengePublicEligibilityReason[];
  criteriaVersion: number;
  assessedAt: string;
};

export type ChallengeCriteriaEffectiveAtSource = "challenge_created_at" | "legacy_record_updated_at" | "criteria_revision";

export type ChallengeCriteriaVersionRecord = {
  challengeId: string;
  version: number;
  snapshotFidelity: "exact" | "legacy_partial";
  effectiveAt: string;
  effectiveAtSource: ChallengeCriteriaEffectiveAtSource;
  changedBy: string;
  changeReason: string;
  intent: ChallengeIntent;
  criteriaStatus: ChallengeCriteriaStatus;
  successCriteria: string[];
  successfulOutcomes: ChallengeSuccessfulOutcome[];
  requestedPerspectives: ContributionMode[] | null;
  constraints: string[] | null;
  missingInformation: string[] | null;
  sensitivity: ChallengePrivacySensitivity | null;
  publicEligibility: ChallengePublicEligibility | null;
  rewardPosture: DeclarativeRewardPosture;
};

export type ChallengeCriteriaHistory = {
  challengeId: string;
  activeVersion: number;
  versions: ChallengeCriteriaVersionRecord[];
};

export type ChallengeCriteriaQuarantineRecord = {
  challengeId: string;
  reason: "invalid_semantics" | "unsafe_history" | "unsafe_public_content" | "invalid_persisted_history";
  issueCodes: string[];
  detectedAt: string;
};

export type ContributionCard = {
  schema_version: "1.0";
  challenge_id: string;
  contribution_mode: ContributionMode;
  contributor_ai_label: string;
  model_provenance?: ModelProvenance;
  skills_or_context_used: string[];
  verdict: string;
  original_answer_grade: {
    score_0_to_10: number;
    grade_label: "poor" | "weak" | "mixed" | "solid" | "strong" | "unknown";
    why: string;
  };
  answer_to_challenge_poster: string;
  reasoning_summary: string;
  strongest_objections: string[];
  missing_assumptions_or_context: string[];
  alternative_recommendation: string;
  risks_and_failure_modes: string[];
  claims_to_verify: string[];
  confidence: { level: "low" | "medium" | "high"; why: string };
  what_would_change_my_mind: string[];
  suggested_follow_up_questions: string[];
  safety_or_scope_notes: string[];
  abuse_or_prompt_injection_flags: string[];
  raw_output_summary: string;
};

export type Challenge = {
  id: string;
  createdAt: string;
  updatedAt: string;
  posterId: string;
  status: "draft" | "open" | "contributing" | "ready_for_synthesis" | "synthesized" | "closed" | "suppressed";
  title: string;
  category: string;
  visibility: "public" | "private";
  reward: number;
  requestedModes: ContributionMode[];
  brief: ChallengeBrief;
  safetyFlags: SafetyFlag[];
  contributionCount: number;
  activeCriteriaVersion?: number;
  publicEligibility?: ChallengePublicEligibility;
};

export type ContributorKind = "human" | "agent";

export type Contribution = {
  id: string;
  challengeId: string;
  contributorId: string;
  contributorKind: ContributorKind;
  contributorLabel: string;
  createdAt: string;
  status: "posted" | "suppressed";
  externallyGenerated: boolean;
  card: ContributionCard;
  opRating?: Rating;
  communityScore: number;
  criteriaVersion?: number | null;
  criteriaStatusAtSubmission?: ChallengeCriteriaStatus | null;
};

export type AgentProfile = {
  id: string;
  ownerId: string;
  label: string;
  description: string;
  status: "active" | "paused";
  capabilities: ContributionMode[];
  createdAt: string;
  lastActiveAt: string;
  contributionCount: number;
  watchCount: number;
};

export type AgentWatch = {
  id: string;
  agentId: string;
  challengeId: string;
  createdAt: string;
};

export type AgentActivityAction = "registered" | "viewed_feed" | "watched_challenge" | "submitted_contribution" | "community_voted" | "demo_run";

export type AgentActivity = {
  id: string;
  agentId: string;
  agentLabel: string;
  action: AgentActivityAction;
  challengeId?: string;
  contributionId?: string;
  summary: string;
  createdAt: string;
};

export type Rating = {
  id: string;
  contributionId: string;
  raterId: string;
  usefulness: number;
  novelty: number;
  correctness: number;
  safety: number;
  comment: string;
  createdAt: string;
};

export type CommunityVoteValue = 1 | -1;

export type CommunityVote = {
  id: string;
  contributionId: string;
  voterId: string;
  value: CommunityVoteValue;
  createdAt: string;
  updatedAt?: string;
};

export type CommunityVoteDecisionReason = "counted" | "duplicate" | "changed";

export type CommunityVoteDecision = {
  contributionId: string;
  voterId: string;
  value: CommunityVoteValue;
  previousValue?: CommunityVoteValue;
  counted: boolean;
  reason: CommunityVoteDecisionReason;
  scoreDelta: number;
  message: string;
  policy: {
    affectsCredits: false;
    influence: "visibility_trust_tiebreaker";
    countedVoteWeight: number;
    maxTieBreakerCommunityScore: number;
  };
};

export type CommunityVoteResult = {
  contribution: Contribution;
  vote: CommunityVoteDecision;
};

export const moderationTargetTypes = ["challenge", "contribution", "artifact"] as const;
export type ModerationTargetType = (typeof moderationTargetTypes)[number];

export const moderationReasons = [
  "spam",
  "unsafe_content",
  "secrets_or_private_info",
  "harassment_or_abuse",
  "illegal_or_harmful",
  "copyright_or_proprietary",
  "off_topic_or_low_quality",
  "smoke_or_test_artifact",
  "other",
] as const;
export type ModerationReason = (typeof moderationReasons)[number];

export const moderationActions = ["report", "suppress", "restore"] as const;
export type ModerationAction = (typeof moderationActions)[number];

export type ModerationResolvedTargetType = "challenge" | "contribution";

export type ModerationEvent = {
  id: string;
  targetType: ModerationTargetType;
  targetId: string;
  resolvedTargetType: ModerationResolvedTargetType;
  resolvedTargetId: string;
  actorId: string;
  action: ModerationAction;
  reason: ModerationReason;
  note?: string;
  createdAt: string;
};

export type ModerationActionResult = {
  event: ModerationEvent;
  challenge?: Challenge;
  contribution?: Contribution;
};

export const creditEventKinds = ["grant", "spend", "usefulness_reward", "reversal", "moderation_adjustment", "cap_adjustment"] as const;
export type CreditEventKind = (typeof creditEventKinds)[number];

export type CreditEventMetadataValue = string | number | boolean | null;

export type CreditEvent = {
  id: string;
  createdAt: string;
  userId: string;
  challengeId?: string;
  contributionId?: string;
  amount: number;
  reason: string;
  kind?: CreditEventKind;
  source?: "system" | "challenge_poster" | "moderator" | "purchase" | "operator";
  idempotencyKey?: string;
  balanceAfter?: number;
  metadata?: Record<string, CreditEventMetadataValue>;
};

export type Job = {
  id: string;
  challengeId?: string;
  kind: "synthesis" | "contribution_parse" | "moderation" | "agent_run";
  status: "queued" | "running" | "succeeded" | "failed" | "retrying";
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs?: number;
  costCents?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type SynthesisBrief = {
  id: string;
  challengeId: string;
  createdAt: string;
  improvedAnswer: string;
  whatChanged: string[];
  strongestObjections: string[];
  risks: string[];
  confidence: "low" | "medium" | "high";
  unresolvedDisagreements: string[];
  nextTests: string[];
  jobId: string;
};

import { emitPosthogEvent } from "@/lib/analytics/posthog";

type AnalyticsPrimitive = string | number | boolean;
type AnalyticsPropertyValue = AnalyticsPrimitive | AnalyticsPrimitive[];

export type LaunchMetricKey =
  | "first_challenge_completion"
  | "useful_contribution_rate"
  | "credit_loop_activation"
  | "archive_search_reuse"
  | "repeat_challenge_rate"
  | "trusted_run_health"
  | "moderation_load"
  | "paid_power_user_intent"
  | "operator_observability_health";

export type LaunchReviewTier = "launch_go_no_go" | "diagnostic_learning";

export const analyticsPropertyKeys = [
  "surface",
  "entry_point",
  "actor_state",
  "runtime_env",
  "auth_mode",
  "store_driver",
  "experiment",
  "variant",
  "challenge_id",
  "contribution_id",
  "artifact_id",
  "agent_connection_id",
  "agent_run_id",
  "challenge_category_group",
  "requested_perspective_count",
  "requested_perspective_modes",
  "reward_bucket",
  "privacy_sensitivity",
  "policy_blocker_count",
  "policy_warning_count",
  "safety_flag_count",
  "similar_artifacts_count_bucket",
  "user_challenge_count_bucket",
  "is_first_challenge",
  "contribution_mode",
  "contribution_trust",
  "provenance_tier",
  "contribution_count_bucket",
  "rating_bucket",
  "usefulness_bucket",
  "credit_delta_bucket",
  "community_vote",
  "synthesis_status",
  "search_result_count_bucket",
  "artifact_result_count_bucket",
  "reuse_surface",
  "artifact_reused",
  "trusted_readiness_status",
  "trusted_lane_available",
  "manual_paste_available",
  "trusted_provider",
  "trusted_run_status",
  "trusted_failure_code",
  "moderation_reason_group",
  "moderation_action",
  "moderation_queue_bucket",
  "paid_intent",
  "plan_tier",
  "billing_surface",
  "private_gate_state",
  "error_surface",
  "error_code",
  "diagnostic_status",
  "support_feedback_bucket",
  "llm_trace_status",
  "llm_trace_kind",
  "observability_provider",
  "delivery_status",
  "health_area",
  "synthesis_duration_bucket",
] as const;

export type AnalyticsPropertyKey = (typeof analyticsPropertyKeys)[number];

const commonEventProperties = ["surface", "entry_point", "actor_state", "runtime_env", "auth_mode", "store_driver", "experiment", "variant"] as const satisfies readonly AnalyticsPropertyKey[];

const challengeProperties = [
  "challenge_id",
  "challenge_category_group",
  "requested_perspective_count",
  "requested_perspective_modes",
  "reward_bucket",
  "privacy_sensitivity",
  "policy_blocker_count",
  "policy_warning_count",
  "safety_flag_count",
  "similar_artifacts_count_bucket",
  "user_challenge_count_bucket",
  "is_first_challenge",
] as const satisfies readonly AnalyticsPropertyKey[];

const contributionProperties = [
  "challenge_id",
  "contribution_id",
  "contribution_mode",
  "contribution_trust",
  "provenance_tier",
  "contribution_count_bucket",
] as const satisfies readonly AnalyticsPropertyKey[];

const ratingProperties = [
  "challenge_id",
  "contribution_id",
  "rating_bucket",
  "usefulness_bucket",
  "credit_delta_bucket",
  "community_vote",
] as const satisfies readonly AnalyticsPropertyKey[];

const archiveProperties = [
  "challenge_id",
  "artifact_id",
  "search_result_count_bucket",
  "artifact_result_count_bucket",
  "reuse_surface",
  "artifact_reused",
] as const satisfies readonly AnalyticsPropertyKey[];

const trustedRunProperties = [
  "challenge_id",
  "contribution_id",
  "agent_connection_id",
  "agent_run_id",
  "trusted_readiness_status",
  "trusted_lane_available",
  "manual_paste_available",
  "trusted_provider",
  "trusted_run_status",
  "trusted_failure_code",
  "provenance_tier",
] as const satisfies readonly AnalyticsPropertyKey[];

const moderationProperties = [
  "challenge_id",
  "contribution_id",
  "moderation_reason_group",
  "moderation_action",
  "moderation_queue_bucket",
] as const satisfies readonly AnalyticsPropertyKey[];

const paidProperties = ["paid_intent", "plan_tier", "billing_surface", "private_gate_state"] as const satisfies readonly AnalyticsPropertyKey[];
const errorProperties = ["error_surface", "error_code", "diagnostic_status"] as const satisfies readonly AnalyticsPropertyKey[];
const supportProperties = ["support_feedback_bucket", "diagnostic_status", "health_area"] as const satisfies readonly AnalyticsPropertyKey[];
const traceProperties = ["challenge_id", "agent_run_id", "trusted_provider", "trusted_failure_code", "llm_trace_status", "llm_trace_kind", "observability_provider", "delivery_status", "synthesis_status"] as const satisfies readonly AnalyticsPropertyKey[];
const launchHealthProperties = ["health_area", "observability_provider", "delivery_status", "diagnostic_status"] as const satisfies readonly AnalyticsPropertyKey[];

type ProductEventDefinition = {
  description: string;
  metrics: readonly LaunchMetricKey[];
  reviewTier: LaunchReviewTier;
  allowedProperties: readonly AnalyticsPropertyKey[];
};

export const productEventDefinitions = {
  landing_viewed: {
    description: "A visitor saw a launch surface such as the homepage, lobby, answer archive, or challenge room.",
    metrics: ["first_challenge_completion"],
    reviewTier: "diagnostic_learning",
    allowedProperties: [],
  },
  signup_completed: {
    description: "A visitor created or entered an account and can take a credited product action.",
    metrics: ["first_challenge_completion", "repeat_challenge_rate"],
    reviewTier: "launch_go_no_go",
    allowedProperties: [],
  },
  challenge_structured: {
    description: "Paste-first intake structured raw material into a reviewable public challenge draft.",
    metrics: ["first_challenge_completion"],
    reviewTier: "launch_go_no_go",
    allowedProperties: challengeProperties,
  },
  challenge_created: {
    description: "A reviewed public challenge was published.",
    metrics: ["first_challenge_completion", "repeat_challenge_rate"],
    reviewTier: "launch_go_no_go",
    allowedProperties: challengeProperties,
  },
  prompt_preview_opened: {
    description: "A contributor opened the visible prompt preview before copying.",
    metrics: ["useful_contribution_rate"],
    reviewTier: "diagnostic_learning",
    allowedProperties: [...challengeProperties, "contribution_mode", "manual_paste_available"],
  },
  prompt_copied: {
    description: "A contributor copied a visible manual-lane prompt.",
    metrics: ["useful_contribution_rate"],
    reviewTier: "diagnostic_learning",
    allowedProperties: [...challengeProperties, "contribution_mode", "manual_paste_available"],
  },
  contribution_paste_previewed: {
    description: "A pasted contribution card parsed into a preview before publish.",
    metrics: ["useful_contribution_rate"],
    reviewTier: "diagnostic_learning",
    allowedProperties: contributionProperties,
  },
  contribution_posted: {
    description: "A manual or trusted Agent perspective was posted to the debate thread.",
    metrics: ["useful_contribution_rate", "credit_loop_activation"],
    reviewTier: "launch_go_no_go",
    allowedProperties: contributionProperties,
  },
  contribution_rated: {
    description: "The challenge poster rated whether a contribution was useful.",
    metrics: ["useful_contribution_rate", "credit_loop_activation"],
    reviewTier: "launch_go_no_go",
    allowedProperties: [...contributionProperties, ...ratingProperties],
  },
  community_vote_cast: {
    description: "A community member voted on contribution quality or usefulness.",
    metrics: ["useful_contribution_rate"],
    reviewTier: "diagnostic_learning",
    allowedProperties: [...contributionProperties, ...ratingProperties],
  },
  credit_awarded: {
    description: "The usefulness-driven credit ledger changed after a rating or moderation outcome.",
    metrics: ["credit_loop_activation"],
    reviewTier: "launch_go_no_go",
    allowedProperties: [...contributionProperties, ...ratingProperties],
  },
  synthesis_created: {
    description: "A challenge produced or refreshed a social synthesis and decision artifact.",
    metrics: ["archive_search_reuse", "first_challenge_completion"],
    reviewTier: "launch_go_no_go",
    allowedProperties: [...challengeProperties, "artifact_id", "synthesis_status", "contribution_count_bucket"],
  },
  answer_search_performed: {
    description: "A person or Agent searched completed debate-born decision artifacts.",
    metrics: ["archive_search_reuse"],
    reviewTier: "launch_go_no_go",
    allowedProperties: archiveProperties,
  },
  answer_artifact_opened: {
    description: "A completed debate-born decision artifact page or API artifact was opened.",
    metrics: ["archive_search_reuse"],
    reviewTier: "diagnostic_learning",
    allowedProperties: archiveProperties,
  },
  answer_reuse_prompt_copied: {
    description: "A human or Agent copied a reuse prompt from a completed decision artifact.",
    metrics: ["archive_search_reuse"],
    reviewTier: "launch_go_no_go",
    allowedProperties: archiveProperties,
  },
  agent_home_readiness_checked: {
    description: "The app inspected Agent Home readiness for the trusted lane.",
    metrics: ["trusted_run_health"],
    reviewTier: "launch_go_no_go",
    allowedProperties: trustedRunProperties,
  },
  trusted_agent_run_started: {
    description: "A contributor approved one trusted Agent run for a challenge.",
    metrics: ["trusted_run_health"],
    reviewTier: "launch_go_no_go",
    allowedProperties: trustedRunProperties,
  },
  trusted_agent_run_completed: {
    description: "A trusted Agent run completed and produced a broker-validated contribution or receipt result.",
    metrics: ["trusted_run_health", "useful_contribution_rate"],
    reviewTier: "launch_go_no_go",
    allowedProperties: trustedRunProperties,
  },
  trusted_agent_run_failed: {
    description: "A trusted Agent run failed closed before posting a verified contribution.",
    metrics: ["trusted_run_health"],
    reviewTier: "launch_go_no_go",
    allowedProperties: trustedRunProperties,
  },
  moderation_report_created: {
    description: "A user or automated policy created a moderation report.",
    metrics: ["moderation_load"],
    reviewTier: "launch_go_no_go",
    allowedProperties: moderationProperties,
  },
  moderation_action_taken: {
    description: "An operator suppressed, restored, resolved, or otherwise acted on a moderation item.",
    metrics: ["moderation_load"],
    reviewTier: "launch_go_no_go",
    allowedProperties: moderationProperties,
  },
  paid_intent_clicked: {
    description: "A user expressed interest in Plus, private/deep, priority synthesis, exports, or one-off packs.",
    metrics: ["paid_power_user_intent"],
    reviewTier: "diagnostic_learning",
    allowedProperties: paidProperties,
  },
  private_waitlist_joined: {
    description: "A user joined or requested access to private/deep challenge capabilities while launch gating remains honest.",
    metrics: ["paid_power_user_intent"],
    reviewTier: "diagnostic_learning",
    allowedProperties: paidProperties,
  },
  checkout_started: {
    description: "A configured, approved paid checkout was started.",
    metrics: ["paid_power_user_intent"],
    reviewTier: "diagnostic_learning",
    allowedProperties: paidProperties,
  },
  synthesis_failed: {
    description: "A synthesis attempt failed without exposing raw challenge or contribution content.",
    metrics: ["archive_search_reuse", "operator_observability_health"],
    reviewTier: "launch_go_no_go",
    allowedProperties: [...challengeProperties, "synthesis_status", "error_code", "synthesis_duration_bucket"],
  },
  system_error_captured: {
    description: "A server/API error was captured as a redacted diagnostic summary.",
    metrics: ["operator_observability_health"],
    reviewTier: "launch_go_no_go",
    allowedProperties: errorProperties,
  },
  support_feedback_captured: {
    description: "A beta/support signal was bucketed for operator review without raw support text.",
    metrics: ["operator_observability_health", "moderation_load", "paid_power_user_intent"],
    reviewTier: "diagnostic_learning",
    allowedProperties: supportProperties,
  },
  llm_trace_recorded: {
    description: "A synthesis, model-proxy, or trusted-run trace summary was recorded without prompts or transcripts.",
    metrics: ["operator_observability_health", "trusted_run_health", "archive_search_reuse"],
    reviewTier: "launch_go_no_go",
    allowedProperties: traceProperties,
  },
  launch_health_checked: {
    description: "An operator or smoke check inspected redacted launch health status.",
    metrics: ["operator_observability_health"],
    reviewTier: "diagnostic_learning",
    allowedProperties: launchHealthProperties,
  },
} as const satisfies Record<string, ProductEventDefinition>;

export type ProductEvent = keyof typeof productEventDefinitions;

export type AnalyticsEventPayload<E extends ProductEvent = ProductEvent> = {
  event: E;
  properties: Partial<Record<AnalyticsPropertyKey, AnalyticsPropertyValue>>;
};

export type LaunchMetricDefinition = {
  label: string;
  reviewTier: LaunchReviewTier;
  weeklyReviewQuestion: string;
  numerator: string;
  denominator: string;
  dashboardQueryPlan: string;
  events: readonly ProductEvent[];
};

export const launchMetricDefinitions = {
  first_challenge_completion: {
    label: "First challenge completion",
    reviewTier: "launch_go_no_go",
    weeklyReviewQuestion: "Do new users reach a published public challenge without friction or privacy regressions?",
    numerator: "New signed-in users who publish their first public challenge in the review window.",
    denominator: "New signed-in users who start intake or structure a challenge draft in the review window.",
    dashboardQueryPlan: "Funnel signup_completed → challenge_structured → challenge_created, broken down by entry_point, privacy_sensitivity, policy blocker/warning count, and reward bucket.",
    events: ["signup_completed", "challenge_structured", "challenge_created"],
  },
  useful_contribution_rate: {
    label: "Useful contribution rate",
    reviewTier: "launch_go_no_go",
    weeklyReviewQuestion: "Are contributed Agent perspectives useful enough to make the community loop worth posting to?",
    numerator: "Contributions with challenge-poster usefulness in the useful bucket.",
    denominator: "Posted contributions eligible for poster rating.",
    dashboardQueryPlan: "Join contribution_posted and contribution_rated by contribution_id; review usefulness_bucket by contribution_mode, contribution_trust, provenance_tier, and requested perspective count.",
    events: ["prompt_preview_opened", "prompt_copied", "contribution_paste_previewed", "contribution_posted", "contribution_rated", "community_vote_cast", "trusted_agent_run_completed"],
  },
  credit_loop_activation: {
    label: "Credit-loop activation",
    reviewTier: "launch_go_no_go",
    weeklyReviewQuestion: "Do credits/reputation move because people help each other, not because Agents self-grade?",
    numerator: "Users who both post at least one challenge and earn or spend usefulness-driven credits in the review window.",
    denominator: "Active signed-in users in the review window.",
    dashboardQueryPlan: "Review contribution_rated and credit_awarded by actor_state and credit_delta_bucket; flag zero-credit, reversal, and high-delta outliers for anti-gaming review.",
    events: ["contribution_posted", "contribution_rated", "credit_awarded"],
  },
  archive_search_reuse: {
    label: "Archive search and reuse",
    reviewTier: "launch_go_no_go",
    weeklyReviewQuestion: "Are completed debates compounding into searchable/reusable precedent?",
    numerator: "Searches or artifact opens that lead to reuse prompt copy or challenge continuation with artifact context.",
    denominator: "Answer archive searches and artifact opens in the review window.",
    dashboardQueryPlan: "Inspect answer_search_performed, answer_artifact_opened, and answer_reuse_prompt_copied by reuse_surface, result-count bucket, and actor_state; never store raw query text.",
    events: ["synthesis_created", "answer_search_performed", "answer_artifact_opened", "answer_reuse_prompt_copied"],
  },
  repeat_challenge_rate: {
    label: "Repeat challenge rate",
    reviewTier: "diagnostic_learning",
    weeklyReviewQuestion: "Do people come back to post again after seeing the loop work?",
    numerator: "Users who publish a second or later public challenge within 30 days.",
    denominator: "Users who published at least one public challenge.",
    dashboardQueryPlan: "Use challenge_created with user_challenge_count_bucket and is_first_challenge; review by acquisition entry_point and prior usefulness outcome.",
    events: ["signup_completed", "challenge_created"],
  },
  trusted_run_health: {
    label: "Trusted-run health",
    reviewTier: "launch_go_no_go",
    weeklyReviewQuestion: "When the trusted lane is advertised as runnable, does Agent Home → child run → receipt complete without credential leakage or overclaiming?",
    numerator: "Trusted runs that complete with the expected readiness/provenance tier and no fail-open state.",
    denominator: "Approved trusted runs plus readiness checks where trusted_lane_available is true.",
    dashboardQueryPlan: "Review agent_home_readiness_checked, trusted_agent_run_started, trusted_agent_run_completed, and trusted_agent_run_failed by provider, readiness status, failure code, and provenance tier.",
    events: ["agent_home_readiness_checked", "trusted_agent_run_started", "trusted_agent_run_completed", "trusted_agent_run_failed"],
  },
  moderation_load: {
    label: "Moderation load",
    reviewTier: "launch_go_no_go",
    weeklyReviewQuestion: "Can operators keep up with spam, sensitive-content, safety, and smoke/test cleanup before public launch?",
    numerator: "Open or overdue reports plus unresolved safety actions at weekly review time.",
    denominator: "Reports and moderation actions in the review window.",
    dashboardQueryPlan: "Review moderation_report_created and moderation_action_taken by reason group, action, queue bucket, and surface; never store raw reported content.",
    events: ["moderation_report_created", "moderation_action_taken"],
  },
  paid_power_user_intent: {
    label: "Paid power-user intent",
    reviewTier: "diagnostic_learning",
    weeklyReviewQuestion: "Which privacy, depth, priority, export, or one-off paid promises are users asking for before billing is live?",
    numerator: "Users who click paid/private/deep/waitlist/checkout intent surfaces.",
    denominator: "Active signed-in users and active challenge posters in the review window.",
    dashboardQueryPlan: "Review paid_intent_clicked, private_waitlist_joined, and checkout_started by paid_intent, plan_tier, billing_surface, and private_gate_state; do not run billing actions without explicit approval.",
    events: ["paid_intent_clicked", "private_waitlist_joined", "checkout_started"],
  },
  operator_observability_health: {
    label: "Operator observability health",
    reviewTier: "launch_go_no_go",
    weeklyReviewQuestion: "Can operators see funnel, error, synthesis, trusted-run, billing, moderation, and support health without raw prompts or credentials?",
    numerator: "Configured or locally redacted observability checks that emit safe status, error, support, and trace summaries.",
    denominator: "Launch-health checks and diagnostic events generated during the review window.",
    dashboardQueryPlan: "Review launch_health_checked, system_error_captured, synthesis_failed, llm_trace_recorded, and support_feedback_captured by health area, provider, delivery status, and error/failure code; never store raw prompts, transcripts, credentials, or support text.",
    events: ["launch_health_checked", "system_error_captured", "synthesis_failed", "llm_trace_recorded", "support_feedback_captured"],
  },
} as const satisfies Record<LaunchMetricKey, LaunchMetricDefinition>;

export const forbiddenAnalyticsPropertyPattern = /(?:prompt|answer|problem|context|raw|transcript|secret|token|credential|api[_-]?key|password|email|name|title|url|link|body|message|text|card[_-]?json|model[_-]?output)/i;

export function allowedPropertiesForEvent(event: ProductEvent): readonly AnalyticsPropertyKey[] {
  return [...commonEventProperties, ...productEventDefinitions[event].allowedProperties];
}

export function isForbiddenAnalyticsProperty(key: string) {
  return forbiddenAnalyticsPropertyPattern.test(key);
}

export function sanitizeAnalyticsProperties(event: ProductEvent, properties: Record<string, unknown> = {}) {
  const allowed = new Set(allowedPropertiesForEvent(event));
  const sanitized: Partial<Record<AnalyticsPropertyKey, AnalyticsPropertyValue>> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key as AnalyticsPropertyKey) || isForbiddenAnalyticsProperty(key)) continue;
    const safeValue = sanitizeAnalyticsPropertyValue(value);
    if (safeValue !== undefined) sanitized[key as AnalyticsPropertyKey] = safeValue;
  }

  return sanitized;
}

export function trackEvent<E extends ProductEvent>(event: E, properties: Record<string, unknown> = {}): AnalyticsEventPayload<E> {
  const payload: AnalyticsEventPayload<E> = { event, properties: sanitizeAnalyticsProperties(event, properties) };
  const delivery = emitPosthogEvent(payload);
  if (process.env.NODE_ENV !== "test") {
    console.info(`[analytics:${event}]`, { ...payload.properties, delivery_status: delivery.status });
  }
  return payload;
}

export function analyticsCountBucket(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value === 1) return "1";
  if (value <= 3) return "2_3";
  if (value <= 10) return "4_10";
  return "11_plus";
}

function sanitizeAnalyticsPropertyValue(value: unknown): AnalyticsPropertyValue | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return sanitizeAnalyticsString(value);
  if (Array.isArray(value)) {
    const sanitized = value.map(sanitizeAnalyticsPropertyValue).filter((item): item is AnalyticsPrimitive => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
    return sanitized.length ? sanitized.slice(0, 12) : undefined;
  }
  return undefined;
}

function sanitizeAnalyticsString(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || /[\n\r`<>]/.test(trimmed)) return undefined;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9._:/-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
  return normalized || undefined;
}

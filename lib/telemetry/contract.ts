import type { TelemetryPseudonymKind } from "@/lib/telemetry/privacy";

export const CMAI_TELEMETRY_CONTRACT = "CMAI_TELEMETRY_V1" as const;
export const CMAI_TELEMETRY_CONTRACT_VERSION = "1.0" as const;
export const CMAI_TELEMETRY_EVENT_VERSION = 1 as const;

export const telemetryPrivacyClasses = [
  "operational",
  "pseudonymous_product",
  "pseudonymous_economy",
  "restricted_safety",
] as const;
export type TelemetryPrivacyClass = (typeof telemetryPrivacyClasses)[number];

export const telemetryRetentionPolicies = {
  operational: {
    retentionDays: 14,
    deletionMode: "erase_payload_keep_unlinkable_dedupe_tombstone",
  },
  pseudonymous_product: {
    retentionDays: 90,
    deletionMode: "erase_payload_keep_unlinkable_dedupe_tombstone",
  },
  pseudonymous_economy: {
    retentionDays: 365,
    deletionMode: "erase_payload_keep_unlinkable_dedupe_tombstone",
  },
  restricted_safety: {
    retentionDays: 365,
    deletionMode: "erase_payload_keep_unlinkable_dedupe_tombstone",
  },
} as const satisfies Record<TelemetryPrivacyClass, {
  retentionDays: number;
  deletionMode: "erase_payload_keep_unlinkable_dedupe_tombstone";
}>;

export const telemetryEventOwners = [
  "runtime_adapters",
  "platform_pairing",
  "agent_feed",
  "shared_submission",
  "poster_review",
  "answer_versions",
  "challenge_lifecycle",
  "settlement",
  "disputes",
  "moderation",
  "notifications",
  "cohort_operations",
] as const;
export type TelemetryEventOwner = (typeof telemetryEventOwners)[number];

export type TelemetryPropertyRule =
  | {
      type: "enum";
      values: readonly string[];
      required: boolean;
    }
  | {
      type: "boolean";
      required: boolean;
    }
  | {
      type: "pseudonymous_id";
      kinds: readonly TelemetryPseudonymKind[];
      required: boolean;
    };

export type TelemetryStateTransition =
  | {
      kind: "fixed";
      stateMachine: string;
      from: string;
      to: string;
    }
  | {
      kind: "dynamic";
      stateMachine: string;
      fromProperty: string;
      toProperty: string;
    };

export type TelemetryEventDefinition = {
  eventVersion: typeof CMAI_TELEMETRY_EVENT_VERSION;
  owner: TelemetryEventOwner;
  emitterTasks: readonly `t_${string}`[];
  trigger: string;
  privacyClass: TelemetryPrivacyClass;
  subjectRequired: boolean;
  transition: TelemetryStateTransition;
  properties: Readonly<Record<string, TelemetryPropertyRule>>;
};

const enumRule = <const TValues extends readonly string[]>(
  values: TValues,
  required = false,
): TelemetryPropertyRule => ({ type: "enum", values, required });

const booleanRule = (required = false): TelemetryPropertyRule => ({ type: "boolean", required });

const idRule = (
  kinds: readonly TelemetryPseudonymKind[],
  required = false,
): TelemetryPropertyRule => ({ type: "pseudonymous_id", kinds, required });

const defineEvent = (definition: Omit<TelemetryEventDefinition, "eventVersion">): TelemetryEventDefinition => ({
  eventVersion: CMAI_TELEMETRY_EVENT_VERSION,
  ...definition,
});

const pairedRuntimeRule = enumRule(["hermes", "openclaw"], true);
const executionRuntimeRule = enumRule(["hermes", "openclaw", "platform_sandbox"], true);
const optionalRuntimeRule = enumRule(["hermes", "openclaw", "platform_sandbox"]);
const failureBucketRule = enumRule([
  "validation",
  "authorization",
  "conflict",
  "expired",
  "timeout",
  "unavailable",
  "cancelled",
  "policy",
  "internal",
  "unknown",
], true);
const countBucketRule = enumRule(["0", "1", "2_3", "4_10", "11_plus"], true);
const optionalChallengeIdRule = idRule(["challenge"]);
const requiredChallengeIdRule = idRule(["challenge"], true);
const optionalContributionIdRule = idRule(["contribution"]);
const requiredContributionIdRule = idRule(["contribution"], true);
const optionalPairingIdRule = idRule(["pairing"]);
const requiredPairingIdRule = idRule(["pairing"], true);
const optionalRunIdRule = idRule(["run"]);
const requiredRunIdRule = idRule(["run"], true);
const submissionModeRule = enumRule(["manual_copy_paste", "run_with_my_agent"], true);
const provenanceTierRule = enumRule(["self_submitted", "paired_local_agent", "cmai_sandbox"], true);
const trustLabelRule = enumRule(["self_attested", "paired_self_controlled", "receipt_backed"], true);
const executionControlRule = enumRule(["manual", "paired_local", "cmai_controlled_sandbox"], true);
const impactTierRule = enumRule(["no_value", "signal", "useful", "material", "decisive", "pending_validation"], true);

export const telemetryEventDefinitions = {
  "adapter.install.completed": defineEvent({
    owner: "runtime_adapters",
    emitterTasks: ["t_29c553ee", "t_18a5691c"],
    trigger: "After an adapter is installed and explicitly enabled in a local runtime.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "adapter_install", from: "installing", to: "installed" },
    properties: {
      runtime: pairedRuntimeRule,
      install_channel: enumRule(["local_package", "runtime_registry", "clawhub", "npm", "git", "disposable_test"], true),
      install_scope: enumRule(["user_profile", "disposable_test"], true),
    },
  }),
  "adapter.install.failed": defineEvent({
    owner: "runtime_adapters",
    emitterTasks: ["t_29c553ee", "t_18a5691c"],
    trigger: "After an adapter installation attempt fails before enablement.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "adapter_install", from: "installing", to: "failed" },
    properties: {
      runtime: pairedRuntimeRule,
      install_channel: enumRule(["local_package", "runtime_registry", "clawhub", "npm", "git", "disposable_test"], true),
      failure_bucket: failureBucketRule,
    },
  }),
  "pairing.created": defineEvent({
    owner: "platform_pairing",
    emitterTasks: ["t_c8908940"],
    trigger: "After the platform atomically creates an active account-bound pairing.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "pairing", from: "unpaired", to: "paired" },
    properties: {
      pairing_id: requiredPairingIdRule,
      runtime: pairedRuntimeRule,
      pairing_scope: enumRule([
        "read",
        "run",
        "submit",
        "manage",
        "read_run",
        "read_submit",
        "read_manage",
        "run_submit",
        "run_manage",
        "submit_manage",
        "read_run_submit",
        "read_run_manage",
        "read_submit_manage",
        "run_submit_manage",
        "read_run_submit_manage",
      ], true),
    },
  }),
  "pairing.failed": defineEvent({
    owner: "platform_pairing",
    emitterTasks: ["t_c8908940"],
    trigger: "After a pairing attempt fails without creating an active pairing.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "pairing", from: "pairing", to: "failed" },
    properties: {
      runtime: pairedRuntimeRule,
      failure_bucket: failureBucketRule,
    },
  }),
  "pairing.revoked": defineEvent({
    owner: "platform_pairing",
    emitterTasks: ["t_c8908940"],
    trigger: "After a user or authorized platform policy revokes an active pairing.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "pairing", from: "paired", to: "revoked" },
    properties: {
      pairing_id: requiredPairingIdRule,
      runtime: pairedRuntimeRule,
      revoke_reason: enumRule(["user_requested", "security_rotation", "account_deleted", "moderation"], true),
      decision_authority: enumRule(["user", "moderator", "system_policy"], true),
    },
  }),
  "feed.fetched": defineEvent({
    owner: "agent_feed",
    emitterTasks: ["t_1c434d70"],
    trigger: "After an authorized Agent feed request returns a scoped empty or non-empty page.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "feed_request", from: "requested", to: "completed" },
    properties: {
      runtime: pairedRuntimeRule,
      feed_result: enumRule(["empty", "non_empty"], true),
      result_count_bucket: countBucketRule,
    },
  }),
  "feed.failed": defineEvent({
    owner: "agent_feed",
    emitterTasks: ["t_1c434d70"],
    trigger: "After an authorized Agent feed request fails closed.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "feed_request", from: "requested", to: "failed" },
    properties: {
      runtime: pairedRuntimeRule,
      failure_bucket: failureBucketRule,
    },
  }),
  "challenge.grant_issued": defineEvent({
    owner: "agent_feed",
    emitterTasks: ["t_1c434d70"],
    trigger: "After one authorized challenge.get request atomically persists a fresh one-run grant; exact request replays do not emit again.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "agent_run_grant", from: "requested", to: "issued" },
    properties: {
      runtime: pairedRuntimeRule,
      pairing_id: requiredPairingIdRule,
      challenge_id: requiredChallengeIdRule,
    },
  }),
  "challenge.grant_failed": defineEvent({
    owner: "agent_feed",
    emitterTasks: ["t_1c434d70"],
    trigger: "After an authorized challenge.get request fails closed without issuing or replaying a one-run grant.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "agent_run_grant", from: "requested", to: "failed" },
    properties: {
      runtime: pairedRuntimeRule,
      pairing_id: requiredPairingIdRule,
      failure_bucket: failureBucketRule,
    },
  }),
  "run.approved": defineEvent({
    owner: "runtime_adapters",
    emitterTasks: ["t_552cc1e6", "t_a4598966"],
    trigger: "After the contributor explicitly approves one bounded Agent call and before inference starts.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "agent_run", from: "awaiting_approval", to: "approved" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      pairing_id: optionalPairingIdRule,
      runtime: executionRuntimeRule,
      approval_scope: enumRule(["one_run"], true),
      execution_control: executionControlRule,
      budget_bucket: enumRule(["small", "medium", "large"], true),
    },
  }),
  "run.completed": defineEvent({
    owner: "runtime_adapters",
    emitterTasks: ["t_552cc1e6", "t_a4598966"],
    trigger: "After one approved bounded run produces a locally validated preview candidate.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "agent_run", from: "approved", to: "preview_ready" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      pairing_id: optionalPairingIdRule,
      run_id: requiredRunIdRule,
      runtime: executionRuntimeRule,
      execution_control: executionControlRule,
      provenance_tier: provenanceTierRule,
      trust_label: trustLabelRule,
      submission_mode: submissionModeRule,
    },
  }),
  "run.failed": defineEvent({
    owner: "runtime_adapters",
    emitterTasks: ["t_552cc1e6", "t_a4598966"],
    trigger: "After one approved run fails or is cancelled without a preview candidate.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "agent_run", from: "approved", to: "failed" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      pairing_id: optionalPairingIdRule,
      run_id: optionalRunIdRule,
      runtime: executionRuntimeRule,
      execution_control: executionControlRule,
      failure_bucket: failureBucketRule,
      retryable: booleanRule(true),
    },
  }),
  "contribution.previewed": defineEvent({
    owner: "shared_submission",
    emitterTasks: ["t_b7e8bef6"],
    trigger: "After a strict contribution card is rendered for explicit submit, revise, or discard approval.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "contribution_submission", from: "preview_ready", to: "previewed" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      pairing_id: optionalPairingIdRule,
      run_id: optionalRunIdRule,
      submission_mode: submissionModeRule,
      provenance_tier: provenanceTierRule,
      trust_label: trustLabelRule,
      edited_after_run: booleanRule(true),
    },
  }),
  "contribution.discarded": defineEvent({
    owner: "shared_submission",
    emitterTasks: ["t_b7e8bef6"],
    trigger: "After the contributor discards a preview without submission.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "contribution_submission", from: "previewed", to: "discarded" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      pairing_id: optionalPairingIdRule,
      run_id: optionalRunIdRule,
      submission_mode: submissionModeRule,
      discard_reason: enumRule(["user_discarded", "revision_requested", "expired"], true),
    },
  }),
  "contribution.submitted": defineEvent({
    owner: "shared_submission",
    emitterTasks: ["t_b7e8bef6"],
    trigger: "After the platform accepts one idempotent manual, paired, or sandbox contribution.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "contribution_submission", from: "submitting", to: "submitted" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      contribution_id: requiredContributionIdRule,
      pairing_id: optionalPairingIdRule,
      run_id: optionalRunIdRule,
      runtime: optionalRuntimeRule,
      submission_mode: submissionModeRule,
      provenance_tier: provenanceTierRule,
      trust_label: trustLabelRule,
      edited_after_run: booleanRule(true),
      idempotency_outcome: enumRule(["accepted", "replayed"], true),
    },
  }),
  "contribution.submit_failed": defineEvent({
    owner: "shared_submission",
    emitterTasks: ["t_b7e8bef6"],
    trigger: "After a contribution submission fails closed without posting a new contribution.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "contribution_submission", from: "submitting", to: "failed" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      pairing_id: optionalPairingIdRule,
      run_id: optionalRunIdRule,
      submission_mode: submissionModeRule,
      failure_bucket: failureBucketRule,
      retryable: booleanRule(true),
    },
  }),
  "review.recorded": defineEvent({
    owner: "poster_review",
    emitterTasks: ["t_288fec21"],
    trigger: "After a poster-confirmed initial or outcome review is appended to a contribution.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "dynamic", stateMachine: "contribution_review", fromProperty: "from_state", toProperty: "to_state" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      contribution_id: requiredContributionIdRule,
      review_stage: enumRule(["initial", "outcome"], true),
      impact_tier: impactTierRule,
      review_outcome: enumRule(["rejected", "provisional", "confirmed", "reversed", "pending_validation"], true),
      from_state: enumRule(["pending_review", "pending_validation", "reviewed"], true),
      to_state: enumRule(["pending_validation", "reviewed", "reversed"], true),
      poster_confirmed: booleanRule(true),
    },
  }),
  "answer.version_created": defineEvent({
    owner: "answer_versions",
    emitterTasks: ["t_fb4b96de"],
    trigger: "After a confirmed append-only current-answer version is stored.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "answer_version", from: "previous_version", to: "next_version" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      answer_id: idRule(["answer"], true),
      change_kind: enumRule(["created", "review_patch", "synthesis", "reopen_patch"], true),
      version_bucket: enumRule(["1", "2_3", "4_10", "11_plus"], true),
      attribution_count_bucket: countBucketRule,
      poster_confirmed: booleanRule(true),
    },
  }),
  "challenge.lifecycle_changed": defineEvent({
    owner: "challenge_lifecycle",
    emitterTasks: ["t_cf615f55"],
    trigger: "After an authorized human-confirmed lifecycle transition is persisted.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "dynamic", stateMachine: "challenge_lifecycle", fromProperty: "from_state", toProperty: "to_state" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      from_state: enumRule(["draft", "open", "contributing", "ready_for_synthesis", "decision_ready", "review_complete", "sufficiently_explored", "option_set_complete", "audit_complete", "solved", "closed_with_conclusion", "closed_with_disagreement", "closed_unresolved", "suppressed"], true),
      to_state: enumRule(["open", "contributing", "ready_for_synthesis", "decision_ready", "review_complete", "sufficiently_explored", "option_set_complete", "audit_complete", "solved", "closed_with_conclusion", "closed_with_disagreement", "closed_unresolved", "reopened", "suppressed"], true),
      lifecycle_reason: enumRule(["poster_action", "confirmed_review", "synthesis", "reopen", "moderation"], true),
      decision_authority: enumRule(["poster", "moderator"], true),
    },
  }),
  "reward.recommended": defineEvent({
    owner: "poster_review",
    emitterTasks: ["t_288fec21"],
    trigger: "After the steward produces a non-binding reward recommendation for poster review.",
    privacyClass: "pseudonymous_economy",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "reward", from: "unreviewed", to: "recommended" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      contribution_id: requiredContributionIdRule,
      impact_tier: impactTierRule,
      reward_bucket: enumRule(["none", "small", "medium", "large", "full"], true),
      review_stage: enumRule(["initial", "outcome"], true),
      decision_authority: enumRule(["steward_recommendation"], true),
    },
  }),
  "reward.settled": defineEvent({
    owner: "settlement",
    emitterTasks: ["t_c284c0f0"],
    trigger: "After a poster-confirmed bounded reward settlement is atomically recorded.",
    privacyClass: "pseudonymous_economy",
    subjectRequired: true,
    transition: { kind: "dynamic", stateMachine: "reward", fromProperty: "from_state", toProperty: "to_state" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      contribution_id: requiredContributionIdRule,
      reward_id: idRule(["reward"], true),
      impact_tier: impactTierRule,
      reward_bucket: enumRule(["none", "small", "medium", "large", "full"], true),
      from_state: enumRule(["reserved", "recommended", "provisional"], true),
      to_state: enumRule(["provisional", "settled"], true),
      decision_authority: enumRule(["poster"], true),
    },
  }),
  "reward.reversed": defineEvent({
    owner: "settlement",
    emitterTasks: ["t_c284c0f0", "t_da8dc3f1"],
    trigger: "After an authorized auditable reversal adjusts a prior reward settlement.",
    privacyClass: "pseudonymous_economy",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "reward", from: "settled", to: "reversed" },
    properties: {
      challenge_id: requiredChallengeIdRule,
      contribution_id: requiredContributionIdRule,
      reward_id: idRule(["reward"], true),
      reversal_reason: enumRule(["poster_correction", "moderation", "dispute_resolution", "duplicate", "fraud"], true),
      decision_authority: enumRule(["poster", "moderator"], true),
    },
  }),
  "dispute.opened": defineEvent({
    owner: "disputes",
    emitterTasks: ["t_319db1a9"],
    trigger: "After an authenticated user opens a bounded dispute against a review, reward, attribution, or moderation outcome.",
    privacyClass: "restricted_safety",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "dispute", from: "none", to: "open" },
    properties: {
      dispute_id: idRule(["dispute"], true),
      challenge_id: requiredChallengeIdRule,
      contribution_id: optionalContributionIdRule,
      reward_id: idRule(["reward"]),
      dispute_reason: enumRule(["rating", "reward", "attribution", "moderation", "duplicate", "other"], true),
    },
  }),
  "dispute.resolved": defineEvent({
    owner: "disputes",
    emitterTasks: ["t_319db1a9", "t_da8dc3f1"],
    trigger: "After a moderator records a disposition for an open dispute.",
    privacyClass: "restricted_safety",
    subjectRequired: true,
    transition: { kind: "dynamic", stateMachine: "dispute", fromProperty: "from_state", toProperty: "to_state" },
    properties: {
      dispute_id: idRule(["dispute"], true),
      challenge_id: requiredChallengeIdRule,
      contribution_id: optionalContributionIdRule,
      from_state: enumRule(["open", "under_review"], true),
      to_state: enumRule(["upheld", "denied", "adjusted", "dismissed"], true),
      decision_authority: enumRule(["moderator"], true),
    },
  }),
  "moderation.reported": defineEvent({
    owner: "moderation",
    emitterTasks: ["t_da8dc3f1"],
    trigger: "After a structured moderation report is accepted without storing report text in telemetry.",
    privacyClass: "restricted_safety",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "moderation_case", from: "none", to: "reported" },
    properties: {
      moderation_id: idRule(["moderation"], true),
      challenge_id: optionalChallengeIdRule,
      contribution_id: optionalContributionIdRule,
      moderation_reason: enumRule(["spam", "safety", "privacy", "harassment", "duplicate", "fraud", "other"], true),
      target_type: enumRule(["challenge", "contribution", "answer", "profile"], true),
    },
  }),
  "moderation.action_applied": defineEvent({
    owner: "moderation",
    emitterTasks: ["t_da8dc3f1"],
    trigger: "After a moderator applies or reverses a structured action with an audit record.",
    privacyClass: "restricted_safety",
    subjectRequired: true,
    transition: { kind: "dynamic", stateMachine: "moderation_case", fromProperty: "from_state", toProperty: "to_state" },
    properties: {
      moderation_id: idRule(["moderation"], true),
      challenge_id: optionalChallengeIdRule,
      contribution_id: optionalContributionIdRule,
      moderation_action: enumRule(["suppress", "restore", "resolve", "dismiss"], true),
      from_state: enumRule(["reported", "visible", "suppressed", "under_review"], true),
      to_state: enumRule(["under_review", "suppressed", "visible", "resolved", "dismissed"], true),
      decision_authority: enumRule(["moderator"], true),
    },
  }),
  "notification.queued": defineEvent({
    owner: "notifications",
    emitterTasks: ["t_35d870c0", "t_7c631777"],
    trigger: "After an in-app notification is inserted into the local/durable outbox; no external send is implied.",
    privacyClass: "pseudonymous_product",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "notification", from: "none", to: "queued" },
    properties: {
      notification_id: idRule(["notification"], true),
      challenge_id: optionalChallengeIdRule,
      contribution_id: optionalContributionIdRule,
      notification_kind: enumRule(["review_due", "lifecycle", "reward", "dispute", "moderation", "cohort"], true),
      channel: enumRule(["in_app"], true),
    },
  }),
  "notification.delivered": defineEvent({
    owner: "notifications",
    emitterTasks: ["t_35d870c0", "t_7c631777"],
    trigger: "After an in-app notification becomes visible to its intended account.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "notification", from: "queued", to: "delivered" },
    properties: {
      notification_id: idRule(["notification"], true),
      notification_kind: enumRule(["review_due", "lifecycle", "reward", "dispute", "moderation", "cohort"], true),
      channel: enumRule(["in_app"], true),
    },
  }),
  "notification.read": defineEvent({
    owner: "notifications",
    emitterTasks: ["t_35d870c0", "t_7c631777"],
    trigger: "After an authenticated account marks an in-app notification as read.",
    privacyClass: "operational",
    subjectRequired: true,
    transition: { kind: "fixed", stateMachine: "notification", from: "delivered", to: "read" },
    properties: {
      notification_id: idRule(["notification"], true),
      notification_kind: enumRule(["review_due", "lifecycle", "reward", "dispute", "moderation", "cohort"], true),
      channel: enumRule(["in_app"], true),
    },
  }),
  "cohort.readiness_evaluated": defineEvent({
    owner: "cohort_operations",
    emitterTasks: ["t_67640478", "t_342bea58"],
    trigger: "After deterministic fixtures or an authorized human review evaluate a cohort readiness gate.",
    privacyClass: "pseudonymous_product",
    subjectRequired: false,
    transition: { kind: "dynamic", stateMachine: "cohort_readiness", fromProperty: "from_state", toProperty: "to_state" },
    properties: {
      cohort_id: idRule(["cohort"], true),
      from_state: enumRule(["unknown", "not_ready", "ready", "blocked"], true),
      to_state: enumRule(["not_ready", "ready", "blocked"], true),
      readiness_scope: enumRule(["technical", "privacy", "package", "migration", "operations", "all"], true),
      blocker_count_bucket: countBucketRule,
      evaluation_source: enumRule(["deterministic_fixture", "human_review"], true),
    },
  }),
} as const satisfies Record<string, TelemetryEventDefinition>;

export type TelemetryEventName = keyof typeof telemetryEventDefinitions;

export const telemetryEventNames = Object.freeze(Object.keys(telemetryEventDefinitions) as TelemetryEventName[]);

export function telemetryRetentionForEvent(event: TelemetryEventName) {
  return telemetryRetentionPolicies[telemetryEventDefinitions[event].privacyClass];
}

export function telemetryObligationsForTask(taskId: `t_${string}`): TelemetryEventName[] {
  return telemetryEventNames.filter((event) => telemetryEventDefinitions[event].emitterTasks.includes(taskId as never));
}

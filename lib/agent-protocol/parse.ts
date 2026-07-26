import type { z } from "zod";
import { agentProtocolBodyLimits, CMAI_AGENT_PROTOCOL, CMAI_AGENT_PROTOCOL_VERSION, type AgentProtocolOperation } from "@/lib/agent-protocol/constants";
import { CREDENTIAL_FIELD_ISSUE_PREFIX } from "@/lib/agent-protocol/credentials";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import { agentProtocolRequestSchemas } from "@/lib/agent-protocol/schemas";

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AgentProtocolError("malformed_request", "Request body must be valid JSON.", 400, false, "$");
  }
}

export function assertSupportedAgentProtocol(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (!("protocol" in candidate) && !("protocol_version" in candidate)) return;
  if (candidate.protocol !== CMAI_AGENT_PROTOCOL || candidate.protocol_version !== CMAI_AGENT_PROTOCOL_VERSION) {
    throw new AgentProtocolError("unsupported_protocol_version", `Only ${CMAI_AGENT_PROTOCOL} ${CMAI_AGENT_PROTOCOL_VERSION} is supported.`, 400, false, "$.protocol_version");
  }
}

export function parseAgentProtocolJson<TSchema extends z.ZodType>(
  operation: AgentProtocolOperation,
  raw: string,
  schema: TSchema,
): z.infer<TSchema> {
  const limit = agentProtocolBodyLimits[operation];
  if (utf8ByteLength(raw) > limit) {
    throw new AgentProtocolError("body_too_large", `${operation} request body exceeds ${limit} bytes.`, 413, false, "$");
  }

  const value = parseJson(raw);
  assertSupportedAgentProtocol(value);

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const credentialIssue = parsed.error.issues.find((issue) => issue.message.startsWith(CREDENTIAL_FIELD_ISSUE_PREFIX));
    if (credentialIssue) {
      throw new AgentProtocolError(
        "credential_field_forbidden",
        "Provider credential-shaped fields are forbidden in the CMAI Agent Protocol.",
        422,
        false,
        credentialIssue.message.slice(CREDENTIAL_FIELD_ISSUE_PREFIX.length),
      );
    }
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue ? `$.${firstIssue.path.join(".")}` : "$";
    const cardMalformed = operation === "contribution.submit" && firstIssue?.path[0] === "payload" && firstIssue.path[1] === "card";
    throw new AgentProtocolError(
      cardMalformed ? "contribution_card_malformed" : "malformed_request",
      cardMalformed ? "CMAI_CONTRIBUTION_CARD_V1 failed strict validation." : "Request body failed strict validation.",
      cardMalformed ? 422 : 400,
      false,
      field,
    );
  }
  return parsed.data;
}

export function parseAgentProtocolRequest(operation: AgentProtocolOperation, raw: string): unknown {
  return parseAgentProtocolJson(operation, raw, agentProtocolRequestSchemas[operation]);
}

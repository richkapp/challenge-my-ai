import type { AgentProtocolOperation } from "../../../lib/agent-protocol/constants";
import type {
  AgentProtocolRequestMap,
  CmaiAgentRunInput,
  CmaiAgentRunResult,
  CmaiAgentRuntimeAdapter,
  CmaiAgentRuntimeIdentity,
  CmaiAgentTransport,
  CmaiAgentTransportOptions,
  CmaiAgentTransportRequest,
  CmaiAgentTransportResponse,
} from "./types";

export type ScriptedTransportStep =
  | CmaiAgentTransportResponse
  | Error
  | ((request: CmaiAgentTransportRequest, options: CmaiAgentTransportOptions) => Promise<CmaiAgentTransportResponse> | CmaiAgentTransportResponse);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deterministic protocol transport for client and later adapter conformance tests. */
export class ScriptedCmaiAgentTransport implements CmaiAgentTransport {
  readonly requests: CmaiAgentTransportRequest[] = [];
  private readonly steps = new Map<AgentProtocolOperation, ScriptedTransportStep[]>();

  enqueue(operation: AgentProtocolOperation, step: ScriptedTransportStep): this {
    const queued = this.steps.get(operation) ?? [];
    queued.push(step);
    this.steps.set(operation, queued);
    return this;
  }

  async send<TOperation extends AgentProtocolOperation>(
    request: CmaiAgentTransportRequest<TOperation>,
    options: CmaiAgentTransportOptions,
  ): Promise<CmaiAgentTransportResponse> {
    this.requests.push(cloneJson(request) as CmaiAgentTransportRequest);
    const queued = this.steps.get(request.operation);
    const step = queued?.shift();
    if (!step) throw new Error(`No scripted response for ${request.operation}.`);
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(request as CmaiAgentTransportRequest, options);
    return cloneJson(step);
  }

  requestsFor<TOperation extends AgentProtocolOperation>(operation: TOperation): Array<AgentProtocolRequestMap[TOperation]> {
    return this.requests
      .filter((request) => request.operation === operation)
      .map((request) => cloneJson(request.envelope) as AgentProtocolRequestMap[TOperation]);
  }
}

export type StaticRuntimeResult = Omit<CmaiAgentRunResult, "identity">;

/** A no-model fake that proves the runtime adapter boundary without child cards. */
export class StaticCmaiAgentRuntimeAdapter implements CmaiAgentRuntimeAdapter {
  readonly calls: CmaiAgentRunInput[] = [];

  constructor(
    readonly identity: CmaiAgentRuntimeIdentity,
    private readonly result: StaticRuntimeResult | ((input: CmaiAgentRunInput) => StaticRuntimeResult),
  ) {}

  async execute(input: CmaiAgentRunInput, _options: { signal?: AbortSignal }): Promise<CmaiAgentRunResult> {
    this.calls.push(cloneJson(input));
    const result = typeof this.result === "function" ? this.result(input) : this.result;
    return { ...cloneJson(result), identity: cloneJson(this.identity) };
  }
}

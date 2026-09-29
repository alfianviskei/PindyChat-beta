import { ContentTypes, StepTypes, Tools } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';

/**
 * Provider-executed built-in web search.
 *
 * OpenAI's Responses API — and the OpenAI-compatible gateways that mirror it,
 * Qwen's `compatible-mode` among them — run `web_search` on their own side of
 * the wire. LangChain's Responses converter never turns those output items into
 * `tool_call_chunk`s: it parks the finished item on
 * `additional_kwargs.tool_outputs` (from `response.output_item.done`) and the
 * lifecycle transitions on `generationInfo.tool_outputs` (from
 * `response.web_search_call.{in_progress,searching,completed}`). The SDK's
 * `ChatModelStreamHandler` reacts only to `tool_call_chunks` / `tool_calls`, so
 * the run yields no `tool_calls` step and the client's `WebSearch` card never
 * mounts — the model browses invisibly.
 *
 * This module is the read side of that gap plus the run-step synthesis that
 * closes it. It lives here rather than in `/api` because it is behavior, not
 * wiring, and it takes every collaborator it needs as an argument.
 */

/** Item types providers use for a server-side web search call. */
const WEB_SEARCH_ITEM_TYPES = new Set(['web_search_call', 'web_search']);

/** Statuses after which no further transition for the same item is expected. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'incomplete', 'cancelled', 'canceled']);

/**
 * Synthetic source indices are negative. `createContentAggregator` resolves a
 * step's persisted slot through `allocateContentIndex(min) =
 * Math.max(nextContentIndex, min)`, while the graph assigns real steps
 * `index: contentData.length` — always `>= 0`. A negative source index can
 * therefore never collide with a real one, and always lands on the next dense
 * slot. That is what lets a fabricated step be injected mid-run without
 * shifting anything the graph already allocated.
 */
const SYNTHETIC_SOURCE_INDEX_BASE = -1;

export type ProviderWebSearchStatus = string;

export type ProviderWebSearchSignal = {
  /** Stable provider id for the call (`ws_…` on OpenAI). Keys the bridge state. */
  itemId: string;
  status: ProviderWebSearchStatus;
  /** The query the provider searched for, when it reports one. */
  query?: string;
  /** Serialized results/sources, when the provider attaches them to the item. */
  output?: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Reads one provider web-search item into a normalized signal.
 *
 * Shapes differ by provider and by which SSE event carried the item:
 * `response.output_item.done` nests the whole item, whereas the
 * `response.web_search_call.*` events carry a flat `{ item_id, type, status }`.
 */
export function readProviderWebSearchItem(item: unknown): ProviderWebSearchSignal | null {
  if (!isRecord(item)) {
    return null;
  }
  const type = firstString(item.type, item.item_type);
  if (type == null || !WEB_SEARCH_ITEM_TYPES.has(type)) {
    return null;
  }
  const itemId = firstString(item.id, item.item_id, item.call_id);
  if (itemId == null) {
    return null;
  }
  const status = firstString(item.status) ?? 'in_progress';
  const action = isRecord(item.action) ? item.action : undefined;
  const query = firstString(action?.query, item.query, action?.search_query);

  /**
   * Results are forwarded only when the provider actually attached them. The
   * card parses `output` as JSON to render sources; an empty string leaves it
   * in its "no sources reported" state rather than fabricating one.
   */
  const results = item.results ?? item.sources ?? action?.results ?? action?.sources;
  let output: string | undefined;
  if (Array.isArray(results) && results.length > 0) {
    try {
      output = JSON.stringify(results);
    } catch (err) {
      logger.debug('[providerWebSearch] Unserializable search results', err);
    }
  }

  return { itemId, status, query, output };
}

function readSignalContainer(container: unknown, out: ProviderWebSearchSignal[]): void {
  if (Array.isArray(container)) {
    for (const entry of container) {
      const signal = readProviderWebSearchItem(entry);
      if (signal != null) {
        out.push(signal);
      }
    }
    return;
  }
  const signal = readProviderWebSearchItem(container);
  if (signal != null) {
    out.push(signal);
  }
}

/**
 * Extracts every provider web-search signal carried by one streamed chunk.
 *
 * Pure and allocation-cheap on the common path: a chunk from a provider that
 * does not do server-side search has none of these keys and returns `[]`
 * after four property reads.
 */
export function readProviderWebSearchSignals(chunk: unknown): ProviderWebSearchSignal[] {
  if (!isRecord(chunk)) {
    return [];
  }
  const signals: ProviderWebSearchSignal[] = [];
  const message = isRecord(chunk.message) ? chunk.message : undefined;
  const kwargs = isRecord(chunk.additional_kwargs)
    ? chunk.additional_kwargs
    : isRecord(message?.additional_kwargs)
      ? message.additional_kwargs
      : undefined;
  readSignalContainer(kwargs?.tool_outputs, signals);

  const generationInfo = isRecord(chunk.generationInfo)
    ? chunk.generationInfo
    : isRecord(chunk.generation_info)
      ? chunk.generation_info
      : isRecord(message?.response_metadata)
        ? message.response_metadata
        : undefined;
  readSignalContainer(generationInfo?.tool_outputs, signals);

  return signals;
}

export function isTerminalProviderWebSearchStatus(status: ProviderWebSearchStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Minimal surface the bridge needs from the run's callback closure. */
export type ProviderWebSearchBridgeDeps = {
  /** The run's content aggregator — the same one every real step is folded into. */
  aggregateContent: (input: { event: string; data: unknown }) => void;
  /** Aggregator-owned `stepId -> runStep` map, read back for the authoritative index. */
  stepMap?: Map<string, { index?: number }> | null;
  /** Forwards an event to the client stream (and to any child-activity sink). */
  emit: (input: { event: string; data: unknown }) => Promise<void> | void;
  /**
   * Routes a synthetic event through the host's own registered handlers rather
   * than straight to the client. Completion and closure go this way so they get
   * exactly the treatment a real step's do: the host's `on_run_step_completed`
   * path folds `result.tool_call` — the `output` the card renders as sources —
   * into the aggregated part, and its `on_run_step_closed` path stamps
   * `runStepStatus` / `runStepDurationMs` onto it. Emitting raw would persist a
   * part carrying neither, so a reload or a resumable reconnect would show a
   * search card frozen mid-flight with no sources. Falls back to `emit`.
   *
   * The opening `on_run_step` deliberately does NOT go through here: this bridge
   * already folds it into the aggregator to learn its persisted slot, and the
   * host handler aggregates again, so dispatching it would fold one step twice.
   */
  dispatch?: (input: { event: string; data: unknown }) => Promise<void> | void;
  /** Event names, supplied by the host so this module stays SDK-agnostic. */
  events: {
    runStep: string;
    runStepCompleted: string;
    runStepClosed: string;
  };
};

/**
 * Run/agent identity for the synthetic step. Taken from the chunk's own
 * metadata rather than fixed at construction, because one handler set serves
 * every agent in a multi-agent graph.
 */
export type ProviderWebSearchIdentity = {
  /** Response message id, stamped as `runId`. */
  runId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
};

type TrackedSearch = {
  stepId: string;
  stepIndex: number;
  createdAt: number;
  status: ProviderWebSearchStatus;
  query?: string;
  output?: string;
  closed: boolean;
};

export type ProviderWebSearchBridge = {
  /**
   * Feed one raw `on_chat_model_stream` chunk. Emits the synthetic run-step
   * events for any provider web-search signal it carries.
   */
  handleChunk: (chunk: unknown, identity?: ProviderWebSearchIdentity | null) => Promise<void>;
  /**
   * Rewrites an outgoing `on_run_step` payload's `index` to the slot the
   * aggregator actually persisted.
   *
   * Needed only because a synthetic step consumes a slot the graph does not
   * know about, after which the graph's own indices lag the persisted ones by
   * the number of injections. Returns the input untouched when nothing was
   * injected, so runs without provider search are bit-for-bit unchanged.
   */
  resolveRunStepEvent: <T extends { id?: string; index?: number }>(data: T) => T;
  /** True once at least one synthetic step has been injected into this run. */
  readonly injected: boolean;
};

/**
 * Builds the per-run bridge. One instance per generation — it holds no state
 * that outlives the run, and its maps are bounded by the number of distinct
 * search items the provider reports.
 *
 * The handler this feeds is deliberately UNBRANDED: the SDK detects its own
 * stream dispatcher by the `SDK_STREAM_DISPATCH` capability symbol, and an
 * unbranded observer leaves `getRegisteredDefaultChatStreamHandler` returning
 * `undefined`, so the SDK still constructs and drives its internal
 * `ChatModelStreamHandler`. Observing the chunk echo neither displaces the
 * dispatcher nor disables cooperative sealing.
 */
export function createProviderWebSearchBridge(
  deps: ProviderWebSearchBridgeDeps,
): ProviderWebSearchBridge {
  const tracked = new Map<string, TrackedSearch>();
  let injected = false;
  let nextSyntheticSourceIndex = SYNTHETIC_SOURCE_INDEX_BASE;
  let nextStepOrdinal = 0;
  let identity: ProviderWebSearchIdentity = {};

  const openStep = async (signal: ProviderWebSearchSignal): Promise<TrackedSearch | null> => {
    const now = Date.now();
    const stepId = `ws_${signal.itemId}`;
    const stepIndex = nextStepOrdinal++;
    const entry: TrackedSearch = {
      stepId,
      stepIndex,
      createdAt: now,
      status: signal.status,
      query: signal.query,
      output: signal.output,
      closed: false,
    };
    tracked.set(signal.itemId, entry);

    const toolCallId = signal.itemId;
    const data = {
      stepIndex,
      id: stepId,
      type: StepTypes.TOOL_CALLS,
      /**
       * Negative on purpose — see `SYNTHETIC_SOURCE_INDEX_BASE`. The aggregator
       * maps it onto the next free persisted slot; `resolveRunStepEvent` reads
       * that slot back out of `stepMap` before the event reaches the client.
       */
      index: nextSyntheticSourceIndex--,
      status: 'in_progress',
      created_at: now,
      ...(identity.runId ? { runId: identity.runId } : {}),
      ...(identity.agentId ? { agent_id: identity.agentId, agentId: identity.agentId } : {}),
      ...(identity.agentName ? { agent_name: identity.agentName } : {}),
      stepDetails: {
        type: StepTypes.TOOL_CALLS,
        id: stepId,
        tool_calls: [
          {
            id: toolCallId,
            name: Tools.web_search,
            args: signal.query != null ? { query: signal.query } : {},
          },
        ],
      },
    };

    deps.aggregateContent({ event: deps.events.runStep, data });
    injected = true;
    await deps.emit({ event: deps.events.runStep, data: resolveIndex(data) });
    return entry;
  };

  const closeStep = async (entry: TrackedSearch, itemId: string): Promise<void> => {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    const completedAt = Date.now();
    const index = deps.stepMap?.get(entry.stepId)?.index;
    const result = {
      id: entry.stepId,
      ...(typeof index === 'number' ? { index } : {}),
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: itemId,
        name: Tools.web_search,
        args: entry.query != null ? { query: entry.query } : {},
        output: entry.output ?? '',
        progress: 1,
      },
      completed_at: completedAt,
    };
    const forward = deps.dispatch ?? deps.emit;
    await forward({ event: deps.events.runStepCompleted, data: { result } });
    await forward({
      event: deps.events.runStepClosed,
      data: {
        id: entry.stepId,
        status: 'completed',
        created_at: entry.createdAt,
        completed_at: completedAt,
      },
    });
  };

  /**
   * Hoisted above `openStep` because that path emits through it too: the
   * synthetic step's own outgoing index must be the persisted one, not the
   * negative placeholder handed to the aggregator.
   */
  function resolveIndex<T extends { id?: string; index?: number }>(data: T): T {
    if (!injected) {
      return data;
    }
    const stepId = data?.id;
    if (typeof stepId !== 'string') {
      return data;
    }
    const persisted = deps.stepMap?.get(stepId)?.index;
    if (typeof persisted !== 'number' || persisted === data.index) {
      return data;
    }
    return { ...data, index: persisted };
  }

  return {
    get injected() {
      return injected;
    },
    resolveRunStepEvent: resolveIndex,
    async handleChunk(chunk: unknown, chunkIdentity?: ProviderWebSearchIdentity | null) {
      const signals = readProviderWebSearchSignals(chunk);
      if (signals.length === 0) {
        return;
      }
      if (chunkIdentity != null) {
        identity = {
          runId: chunkIdentity.runId ?? identity.runId,
          agentId: chunkIdentity.agentId ?? identity.agentId,
          agentName: chunkIdentity.agentName ?? identity.agentName,
        };
      }
      for (const signal of signals) {
        try {
          const existing = tracked.get(signal.itemId);
          if (existing == null) {
            await openStep(signal);
            if (isTerminalProviderWebSearchStatus(signal.status)) {
              const opened = tracked.get(signal.itemId);
              if (opened != null) {
                await closeStep(opened, signal.itemId);
              }
            }
            continue;
          }
          if (existing.closed) {
            continue;
          }
          existing.status = signal.status;
          if (signal.query != null) {
            existing.query = signal.query;
          }
          if (signal.output != null) {
            existing.output = signal.output;
          }
          if (isTerminalProviderWebSearchStatus(signal.status)) {
            await closeStep(existing, signal.itemId);
          }
        } catch (err) {
          /**
           * A failed indicator must never take the generation down with it —
           * the search itself already succeeded on the provider's side.
           */
          logger.warn('[providerWebSearch] Failed to surface web search step', err);
        }
      }
    },
  };
}

import {
  createProviderWebSearchBridge,
  isTerminalProviderWebSearchStatus,
  readProviderWebSearchSignals,
} from './providerWebSearch';

const RUN_STEP = 'on_run_step';
const RUN_STEP_COMPLETED = 'on_run_step_completed';
const RUN_STEP_CLOSED = 'on_run_step_closed';

type Emitted = { event: string; data: any };

/**
 * Miniature of `createContentAggregator`'s slot allocation —
 * `allocateContentIndex(min) = Math.max(nextContentIndex, min)` — paired with
 * the graph's own `index = contentData.length` for real steps. Reproducing both
 * sides is what makes the negative-source-index invariant observable.
 */
function makeHarness() {
  let nextContentIndex = 0;
  const stepMap = new Map<string, { index?: number }>();
  const slots: Array<{ stepId: string } | undefined> = [];
  const emitted: Emitted[] = [];

  const aggregateContent = ({ event, data }: { event: string; data: any }) => {
    if (event !== RUN_STEP) {
      return;
    }
    const index = Math.max(nextContentIndex, data.index);
    nextContentIndex = index + 1;
    stepMap.set(data.id, { ...data, index });
    slots[index] = { stepId: data.id };
  };

  const bridge = createProviderWebSearchBridge({
    aggregateContent,
    stepMap,
    emit: ({ event, data }) => {
      emitted.push({ event, data: JSON.parse(JSON.stringify(data)) });
    },
    events: {
      runStep: RUN_STEP,
      runStepCompleted: RUN_STEP_COMPLETED,
      runStepClosed: RUN_STEP_CLOSED,
    },
  });

  /** A genuine graph-dispatched step, routed the way `callbacks.js` routes it. */
  const realStep = (id: string) => {
    const data = {
      id,
      stepIndex: 0,
      type: 'tool_calls',
      index: slots.filter(Boolean).length,
      status: 'in_progress',
      stepDetails: { type: 'tool_calls', id, tool_calls: [{ id: 'call_x', name: 'shell' }] },
    };
    aggregateContent({ event: RUN_STEP, data });
    return bridge.resolveRunStepEvent(data);
  };

  const only = (event: string) => emitted.filter((entry) => entry.event === event);
  const lifecycle = (itemId: string, status: string) => ({
    generationInfo: { tool_outputs: { item_id: itemId, type: 'web_search_call', status } },
  });

  return { bridge, emitted, stepMap, slots, realStep, only, lifecycle };
}

describe('readProviderWebSearchSignals', () => {
  it('reads the nested `response.output_item.done` shape', () => {
    const signals = readProviderWebSearchSignals({
      message: {
        additional_kwargs: {
          tool_outputs: [
            {
              type: 'web_search_call',
              id: 'ws_abc123',
              status: 'completed',
              action: { type: 'search', query: 'qwen latest release' },
            },
          ],
        },
      },
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      itemId: 'ws_abc123',
      status: 'completed',
      query: 'qwen latest release',
    });
  });

  it('reads the flat `response.web_search_call.*` lifecycle shape', () => {
    const flat = (status: string) =>
      readProviderWebSearchSignals({
        generationInfo: { tool_outputs: { item_id: 'ws_1', type: 'web_search_call', status } },
      });

    expect(flat('in_progress')[0]).toMatchObject({ itemId: 'ws_1', status: 'in_progress' });
    expect(flat('searching')[0]).toMatchObject({ itemId: 'ws_1', status: 'searching' });
  });

  it('ignores chunks that carry no provider web search', () => {
    expect(readProviderWebSearchSignals({ message: { content: 'hello' } })).toEqual([]);
    expect(
      readProviderWebSearchSignals({
        additional_kwargs: {
          tool_outputs: [{ type: 'function_call', id: 'f1', status: 'completed' }],
        },
      }),
    ).toEqual([]);
    expect(
      readProviderWebSearchSignals({
        generationInfo: {
          tool_outputs: { type: 'code_interpreter_call', id: 'ci1', status: 'completed' },
        },
      }),
    ).toEqual([]);
  });

  it('is total over hostile input', () => {
    for (const chunk of [null, undefined, 'nope', 42, [], {}, { generationInfo: null }]) {
      expect(readProviderWebSearchSignals(chunk)).toEqual([]);
    }
    // A web-search item with no id cannot be tracked, so it must be dropped.
    expect(
      readProviderWebSearchSignals({
        generationInfo: { tool_outputs: { type: 'web_search_call', status: 'completed' } },
      }),
    ).toEqual([]);
  });
});

describe('isTerminalProviderWebSearchStatus', () => {
  it('treats only settled statuses as terminal', () => {
    expect(isTerminalProviderWebSearchStatus('completed')).toBe(true);
    expect(isTerminalProviderWebSearchStatus('failed')).toBe(true);
    expect(isTerminalProviderWebSearchStatus('incomplete')).toBe(true);
    expect(isTerminalProviderWebSearchStatus('searching')).toBe(false);
    expect(isTerminalProviderWebSearchStatus('in_progress')).toBe(false);
  });
});

describe('createProviderWebSearchBridge', () => {
  it('opens one web_search step per provider call and closes it exactly once', async () => {
    const h = makeHarness();
    await h.bridge.handleChunk(h.lifecycle('ws_9', 'in_progress'), {
      runId: 'resp_msg_1',
      agentId: 'agent_1',
      agentName: 'Qwen',
    });
    await h.bridge.handleChunk(h.lifecycle('ws_9', 'searching'));
    await h.bridge.handleChunk(h.lifecycle('ws_9', 'completed'));
    // Providers repeat the settled item on `output_item.done` as well.
    await h.bridge.handleChunk({
      message: {
        additional_kwargs: {
          tool_outputs: [{ type: 'web_search_call', id: 'ws_9', status: 'completed' }],
        },
      },
    });

    const steps = h.only(RUN_STEP);
    expect(steps).toHaveLength(1);
    expect(steps[0].data.stepDetails).toMatchObject({
      type: 'tool_calls',
      tool_calls: [{ id: 'ws_9', name: 'web_search' }],
    });
    expect(steps[0].data).toMatchObject({
      runId: 'resp_msg_1',
      agentId: 'agent_1',
      agent_name: 'Qwen',
      status: 'in_progress',
    });

    expect(h.only(RUN_STEP_COMPLETED)).toHaveLength(1);
    expect(h.only(RUN_STEP_CLOSED)).toHaveLength(1);
    expect(h.only(RUN_STEP_COMPLETED)[0].data.result).toMatchObject({
      type: 'tool_call',
      tool_call: { id: 'ws_9', name: 'web_search', progress: 1 },
    });
    expect(h.only(RUN_STEP_CLOSED)[0].data.status).toBe('completed');
  });

  it('emits the persisted slot, never the negative placeholder', async () => {
    const h = makeHarness();
    await h.bridge.handleChunk(h.lifecycle('ws_A', 'searching'));

    const step = h.only(RUN_STEP)[0].data;
    expect(step.index).toBeGreaterThanOrEqual(0);
    expect(step.index).toBe(h.stepMap.get(step.id)?.index);
  });

  it('keeps slots dense and collision-free around a real step', async () => {
    const h = makeHarness();
    expect(h.realStep('step_real_0').index).toBe(0);

    await h.bridge.handleChunk(h.lifecycle('ws_A', 'searching'));
    const synthetic = h.only(RUN_STEP)[0].data;
    expect(synthetic.index).toBe(1);

    // The graph still counts only its own steps, so its index now lags the
    // persisted slot by the number of injections; the bridge corrects it.
    expect(h.realStep('step_real_1').index).toBe(2);

    const filled = h.slots.filter(Boolean);
    expect(filled).toHaveLength(3);
    expect(new Set(filled.map((slot) => slot?.stepId)).size).toBe(3);
    expect(h.slots[1]?.stepId).toBe(synthetic.id);
  });

  it('is the identity until something is injected', () => {
    const h = makeHarness();
    const data = { id: 'step_z', index: 4 };

    expect(h.bridge.injected).toBe(false);
    expect(h.bridge.resolveRunStepEvent(data)).toBe(data);

    const unknown = { id: 'never_seen', index: 7 };
    expect(h.bridge.resolveRunStepEvent(unknown)).toBe(unknown);
  });

  it('tracks concurrent searches independently', async () => {
    const h = makeHarness();
    await h.bridge.handleChunk(h.lifecycle('ws_1', 'searching'));
    await h.bridge.handleChunk(h.lifecycle('ws_2', 'searching'));
    await h.bridge.handleChunk(h.lifecycle('ws_1', 'completed'));
    await h.bridge.handleChunk(h.lifecycle('ws_2', 'completed'));

    expect(h.only(RUN_STEP)).toHaveLength(2);
    expect(h.only(RUN_STEP_COMPLETED)).toHaveLength(2);
    expect(new Set(h.only(RUN_STEP).map((entry) => entry.data.index)).size).toBe(2);
  });

  it('survives a provider that reports only the settled item', async () => {
    const h = makeHarness();
    await h.bridge.handleChunk({
      message: {
        additional_kwargs: {
          tool_outputs: [
            {
              type: 'web_search_call',
              id: 'ws_solo',
              status: 'completed',
              action: { query: 'solo' },
              results: [{ url: 'https://a.test', title: 'A' }],
            },
          ],
        },
      },
    });

    expect(h.only(RUN_STEP)).toHaveLength(1);
    expect(h.only(RUN_STEP_COMPLETED)).toHaveLength(1);
    const toolCall = h.only(RUN_STEP_COMPLETED)[0].data.result.tool_call;
    expect(toolCall.args).toEqual({ query: 'solo' });
    expect(JSON.parse(toolCall.output)[0].url).toBe('https://a.test');
  });

  it('closes the card on failure instead of leaving it spinning', async () => {
    const h = makeHarness();
    await h.bridge.handleChunk(h.lifecycle('ws_f', 'in_progress'));
    await h.bridge.handleChunk(h.lifecycle('ws_f', 'failed'));
    expect(h.only(RUN_STEP_CLOSED)).toHaveLength(1);

    await h.bridge.handleChunk(h.lifecycle('ws_f', 'completed'));
    expect(h.only(RUN_STEP_CLOSED)).toHaveLength(1);
  });

  it('never lets an indicator fault escape into the generation', async () => {
    const bridge = createProviderWebSearchBridge({
      aggregateContent: () => {
        throw new Error('aggregator gone');
      },
      emit: () => {
        throw new Error('transport gone');
      },
      events: {
        runStep: RUN_STEP,
        runStepCompleted: RUN_STEP_COMPLETED,
        runStepClosed: RUN_STEP_CLOSED,
      },
    });

    await expect(
      bridge.handleChunk({
        generationInfo: {
          tool_outputs: { item_id: 'ws_err', type: 'web_search_call', status: 'completed' },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('does no work for chunks without a provider search', async () => {
    const h = makeHarness();
    for (let i = 0; i < 100; i++) {
      await h.bridge.handleChunk({ message: { content: `token ${i}` }, additional_kwargs: {} });
    }

    expect(h.emitted).toHaveLength(0);
    expect(h.slots.filter(Boolean)).toHaveLength(0);
    expect(h.bridge.injected).toBe(false);
  });

  /**
   * `callbacks.js` supplies `dispatch` so completion and closure re-enter its
   * own handlers — that is what folds `result.tool_call` into the persisted
   * part and stamps `runStepStatus`. The opening step must stay on `emit`,
   * because the bridge already aggregated it to learn its slot and the host
   * handler would aggregate it a second time.
   */
  it('routes completion and closure through dispatch, and only those', async () => {
    let nextContentIndex = 0;
    const stepMap = new Map<string, { index?: number }>();
    const emitted: Emitted[] = [];
    const dispatched: Emitted[] = [];

    const bridge = createProviderWebSearchBridge({
      aggregateContent: ({ data }: { event: string; data: any }) => {
        const index = Math.max(nextContentIndex, data.index);
        nextContentIndex = index + 1;
        stepMap.set(data.id, { ...data, index });
      },
      stepMap,
      emit: ({ event, data }) => emitted.push({ event, data }),
      dispatch: ({ event, data }) => dispatched.push({ event, data }),
      events: {
        runStep: RUN_STEP,
        runStepCompleted: RUN_STEP_COMPLETED,
        runStepClosed: RUN_STEP_CLOSED,
      },
    });

    await bridge.handleChunk({
      generationInfo: { tool_outputs: { item_id: 'ws_d', type: 'web_search_call', status: 'searching' } },
    });
    await bridge.handleChunk({
      generationInfo: { tool_outputs: { item_id: 'ws_d', type: 'web_search_call', status: 'completed' } },
    });

    expect(emitted.map((entry) => entry.event)).toEqual([RUN_STEP]);
    expect(dispatched.map((entry) => entry.event)).toEqual([
      RUN_STEP_COMPLETED,
      RUN_STEP_CLOSED,
    ]);
    // The host handler resolves the part by `result.id`, so it must be the step id.
    expect(dispatched[0].data.result.id).toBe(emitted[0].data.id);
    expect(dispatched[1].data.id).toBe(emitted[0].data.id);
  });

  it('falls back to emit when the host supplies no dispatch', async () => {
    const h = makeHarness();
    await h.bridge.handleChunk(h.lifecycle('ws_fb', 'completed'));

    expect(h.only(RUN_STEP_COMPLETED)).toHaveLength(1);
    expect(h.only(RUN_STEP_CLOSED)).toHaveLength(1);
  });
});

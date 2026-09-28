import type { SessionEvent, StreamEvent, ToolCall } from "@basis/contracts";

/**
 * Streaming state for one session: what the model is producing right now,
 * built from `delta` events until the durable `message`/`attempt` event for
 * the step lands in the log. Pure; the store holds the current value.
 */

export type DraftBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly args: string; readonly call?: ToolCall };

export interface StepDraft {
  readonly turnId: string;
  readonly stepId: string;
  /** Indexed by content block index; holes stay undefined until their first delta. */
  readonly blocks: readonly (DraftBlock | undefined)[];
  /** The stream finished (done or error); waiting for the durable event. */
  readonly finished: boolean;
  readonly error?: string;
}

export interface LiveState {
  readonly drafts: readonly StepDraft[];
  /** Steps whose durable event arrived; late deltas for them are ignored. */
  readonly settled: ReadonlySet<string>;
}

export const emptyLive: LiveState = { drafts: [], settled: new Set() };

const setBlock = (blocks: readonly (DraftBlock | undefined)[], index: number, block: DraftBlock) => {
  const next = blocks.slice();
  next[index] = block;
  return next;
};

const applyToDraft = (draft: StepDraft, event: StreamEvent): StepDraft => {
  switch (event.type) {
    case "start":
      return draft;
    case "text-delta":
    case "thinking-delta": {
      const kind = event.type === "text-delta" ? "text" : "thinking";
      const existing = draft.blocks[event.index];
      const text = existing !== undefined && existing.kind === kind ? existing.text + event.delta : event.delta;
      return { ...draft, blocks: setBlock(draft.blocks, event.index, { kind, text }) };
    }
    case "toolcall-start":
      return { ...draft, blocks: setBlock(draft.blocks, event.index, { kind: "tool", id: event.id, name: event.name, args: "" }) };
    case "toolcall-delta": {
      const existing = draft.blocks[event.index];
      const block: DraftBlock = existing?.kind === "tool"
        ? { ...existing, args: existing.args + event.delta }
        : { kind: "tool", id: "", name: "", args: event.delta };
      return { ...draft, blocks: setBlock(draft.blocks, event.index, block) };
    }
    case "toolcall-end":
      return {
        ...draft,
        blocks: setBlock(draft.blocks, event.index, {
          kind: "tool", id: event.toolCall.id, name: event.toolCall.name, args: JSON.stringify(event.toolCall.arguments), call: event.toolCall,
        }),
      };
    case "done":
      return { ...draft, finished: true };
    case "error":
      return { ...draft, finished: true, ...(event.message.errorMessage === undefined ? {} : { error: event.message.errorMessage }) };
  }
};

export const applyDelta = (state: LiveState, turnId: string, stepId: string, event: StreamEvent): LiveState => {
  if (state.settled.has(stepId)) return state;
  const index = state.drafts.findIndex((draft) => draft.stepId === stepId);
  const draft = index === -1 ? { turnId, stepId, blocks: [], finished: false } : state.drafts[index]!;
  const next = applyToDraft(draft, event);
  if (next === draft && index !== -1) return state;
  const drafts = state.drafts.slice();
  if (index === -1) drafts.push(next);
  else drafts[index] = next;
  return { ...state, drafts };
};

/** The durable event for `stepId` arrived: drop its draft and ignore stragglers. */
export const settleStep = (state: LiveState, stepId: string): LiveState => {
  if (state.settled.has(stepId) && !state.drafts.some((draft) => draft.stepId === stepId)) return state;
  const settled = new Set(state.settled);
  settled.add(stepId);
  return { drafts: state.drafts.filter((draft) => draft.stepId !== stepId), settled };
};

/** A turn ended: nothing more will stream for it. */
export const endTurn = (state: LiveState, turnId: string): LiveState => {
  if (!state.drafts.some((draft) => draft.turnId === turnId)) return state;
  const settled = new Set(state.settled);
  for (const draft of state.drafts) if (draft.turnId === turnId) settled.add(draft.stepId);
  return { drafts: state.drafts.filter((draft) => draft.turnId !== turnId), settled };
};

/**
 * Settles drafts the durable log already covers. Deltas and turn events can be
 * lost while disconnected; the log fetched on reconnect is authoritative.
 */
export const reconcileLive = (state: LiveState, events: readonly SessionEvent[]): LiveState => {
  if (state.drafts.length === 0) return state;
  let next = state;
  for (const { data } of events) {
    if (data.type === "message" && data.message.role === "assistant" && data.stepId !== undefined) next = settleStep(next, data.stepId);
    else if (data.type === "attempt") next = settleStep(next, data.stepId);
    else if (data.type === "turn-end") next = endTurn(next, data.turnId);
  }
  return next;
};

/** Best-effort parse of streamed tool arguments (partial JSON while streaming). */
export const parseDraftArgs = (block: Extract<DraftBlock, { kind: "tool" }>): Record<string, unknown> | undefined => {
  if (block.call !== undefined) return block.call.arguments;
  try {
    const value: unknown = JSON.parse(block.args);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

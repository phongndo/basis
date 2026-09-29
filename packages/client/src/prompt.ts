import type { PromptContent, TurnOptions } from "@basis/contracts";
import type { Host } from "./host.ts";

export interface StartedPrompt {
  /**
   * Resolves once the agent has taken the prompt (its turn started), rejects
   * when the prompt is refused (`Busy`, no model, the session is gone). A
   * client clears its input only after this resolves.
   */
  readonly accepted: Promise<void>;
  /** Settles when the turn ends, as `Host.agent.prompt` does. */
  readonly done: Promise<void>;
}

/**
 * Sends a prompt and reports acceptance separately from completion.
 * `Agent.Prompt` only returns when the turn ends; a refusal fails it before
 * the agent publishes `turn-started`. So the prompt counts as accepted at the
 * first `turn-started` for the session, or when `done` resolves if that
 * (losable) event never arrived.
 */
export function startPrompt(host: Pick<Host, "agent" | "onEvent">, sessionId: string, content: PromptContent, options?: TurnOptions): StartedPrompt {
  let stop = () => {};
  const started = new Promise<void>((resolve) => {
    stop = host.onEvent((event) => {
      if (event.type === "turn-started" && event.sessionId === sessionId) resolve();
    });
  });
  const done = host.agent.prompt(sessionId, content, options);
  const accepted = Promise.race([started, done]);
  void accepted.then(stop, stop);
  return { accepted, done };
}

import { Context, Effect, Stream } from "effect";
import { HostRpcs } from "@basis/contracts";
import type { Agent, Credentials, HostControl, Llm, Sessions } from "@basis/contracts";
import { toHostError, toPluginStatus } from "./errors.ts";
import type { Hub } from "./hub.ts";
import type { Interactions } from "./interactions.ts";

export interface HandlerServices {
  readonly hub: Hub;
  readonly interactions: Interactions;
  readonly agent: Context.Tag.Service<Agent>;
  readonly sessions: Context.Tag.Service<Sessions>;
  readonly llm: Context.Tag.Service<Llm>;
  readonly credentials: Context.Tag.Service<Credentials>;
  readonly control: Context.Tag.Service<HostControl>;
}

/** Every Rpc maps to one contract call; only the error boundary is transport-specific. */
export const makeHandlers = ({ hub, interactions, agent, sessions, llm, credentials, control }: HandlerServices) =>
  HostRpcs.of({
    "Session.List": ({ cwd }) => sessions.list(cwd === undefined ? undefined : { cwd }).pipe(Effect.mapError(toHostError)),
    "Session.Get": ({ sessionId }) => sessions.get(sessionId).pipe(Effect.mapError(toHostError)),
    "Session.Create": ({ cwd }) => sessions.create(cwd ?? process.cwd()).pipe(Effect.mapError(toHostError)),
    "Session.Entries": ({ sessionId }) => sessions.entries(sessionId).pipe(Stream.mapError(toHostError)),
    "Session.Context": ({ sessionId }) => sessions.context(sessionId).pipe(Effect.mapError(toHostError)),
    "Session.Append": ({ sessionId, payload, parent }) =>
      sessions.append(sessionId, payload, parent === undefined ? undefined : { parent }).pipe(Effect.mapError(toHostError)),
    "Session.Checkout": ({ sessionId, entryId }) => sessions.checkout(sessionId, entryId).pipe(Effect.mapError(toHostError)),
    "Session.SetTitle": ({ sessionId, title }) => sessions.setTitle(sessionId, title).pipe(Effect.mapError(toHostError)),

    "Agent.Prompt": ({ sessionId, message, options }) => agent.prompt(sessionId, message, options).pipe(Effect.mapError(toHostError)),
    "Agent.Cancel": ({ sessionId }) => agent.cancel(sessionId),
    "Agent.Busy": ({ sessionId }) => agent.busy(sessionId),
    "Agent.Preview": ({ sessionId, options }) => agent.preview(sessionId, options).pipe(Effect.mapError(toHostError)),

    "Llm.Models": () => llm.models.pipe(Effect.mapError(toHostError)),
    "Credentials.List": () => credentials.list.pipe(Effect.mapError(toHostError)),
    "Credentials.Methods": () => credentials.methods,
    "Credentials.Login": ({ provider, methodId }) =>
      credentials.login(provider, methodId).pipe(Effect.map((credential) => ({ type: credential.type })), Effect.mapError(toHostError)),
    "Credentials.Set": ({ provider, credential }) => credentials.set(provider, credential).pipe(Effect.mapError(toHostError)),
    "Credentials.Remove": ({ provider }) => credentials.remove(provider).pipe(Effect.mapError(toHostError)),

    "Interaction.Answer": ({ id, answer }) => interactions.answer(id, answer),
    "Interaction.Dismiss": ({ id }) => interactions.dismiss(id),

    "Host.Events": () => hub.events,
    "Host.Plugins": () => Effect.map(control.plugins, (plugins) => plugins.map(toPluginStatus)),
    "Host.RestartPlugin": ({ pluginId }) => control.restart(pluginId).pipe(Effect.mapError(toHostError)),
    "Host.Reload": () => control.reload.pipe(
      Effect.map((report) => ({ started: report.started, restarted: report.restarted, stopped: report.stopped })),
      Effect.mapError(toHostError),
    ),
  });

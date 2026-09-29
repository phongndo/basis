import { Cause } from "effect";
import { HostError } from "@basis/contracts";
import type { PluginStatus } from "@basis/contracts";
import type { Diagnostic, PluginSnapshot } from "@basis/core";

interface Tagged {
  readonly _tag: string;
  readonly reason?: unknown;
  readonly message?: unknown;
  readonly sessionId?: unknown;
  readonly provider?: unknown;
  readonly pluginId?: unknown;
  readonly tool?: unknown;
  readonly path?: unknown;
  readonly command?: unknown;
  readonly diagnostics?: readonly Diagnostic[];
}

const isTagged = (error: unknown): error is Tagged => typeof error === "object" && error !== null && typeof (error as Tagged)._tag === "string";

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  `${diagnostic.severity}${diagnostic.pluginId === undefined ? "" : ` [${diagnostic.pluginId}]`}: ${diagnostic.message}` +
  (diagnostic.suggestion === undefined ? "" : ` (${diagnostic.suggestion})`);

/**
 * Domain errors cross the wire as `HostError`. `code` is the error's `reason`
 * when it has one (`Busy`, `NotFound`), else its tag (`ReloadError`,
 * `CoreClosed`); `subject` is the session, provider, plugin, tool, workspace
 * path, or command concerned.
 * A `ReloadError`'s diagnostics become the message, one per line.
 */
export const toHostError = (error: unknown): HostError => {
  if (error instanceof HostError) return error;
  if (!isTagged(error)) return new HostError({ code: "Unknown", message: error instanceof Error ? error.message : String(error) });
  const code = text(error.reason) ?? error._tag;
  const subject = text(error.sessionId) ?? text(error.provider) ?? text(error.pluginId) ?? text(error.tool) ?? text(error.path) ?? text(error.command);
  const message = error.diagnostics?.length ? error.diagnostics.map(formatDiagnostic).join("\n") : (text(error.message) ?? code);
  return new HostError({ code, message, ...(subject === undefined ? {} : { subject }) });
};

export const toPluginStatus = (snapshot: PluginSnapshot): PluginStatus => {
  const fault = snapshot.fault;
  const cause = fault === undefined ? undefined : Cause.squash(fault.cause);
  return {
    id: snapshot.id,
    ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
    state: snapshot.state,
    ...(fault === undefined
      ? {}
      : {
          fault: {
            phase: fault.phase,
            ...(fault.operation === undefined ? {} : { operation: fault.operation }),
            message: `${fault.message}: ${cause instanceof Error ? cause.message : String(cause)}`,
          },
        }),
    ...(snapshot.haltedBy === undefined ? {} : { haltedBy: snapshot.haltedBy }),
  };
};

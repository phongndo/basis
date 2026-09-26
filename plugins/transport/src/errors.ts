import { Cause } from "effect";
import { HostError } from "@basis/contracts";
import type { PluginStatus } from "@basis/contracts";
import type { PluginSnapshot } from "@basis/core";

interface Tagged {
  readonly _tag: string;
  readonly reason?: string;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly pluginId?: string;
}

const isTagged = (error: unknown): error is Tagged =>
  typeof error === "object" && error !== null && typeof (error as Tagged)._tag === "string";

/** Retryability that the domain error types imply without saying so. */
const retryable = (error: Tagged): boolean | undefined => {
  if (typeof error.retryable === "boolean") return error.retryable;
  if (error._tag === "AgentError") return error.reason === "Busy";
  if (error._tag === "SessionError" || error._tag === "CredentialError") return error.reason === "Io";
  return undefined;
};

/**
 * Domain errors cross the wire as `HostError` with `code` = `<tag>.<reason>`
 * so clients can branch without importing every error class.
 */
export const toHostError = (error: unknown): HostError => {
  if (error instanceof HostError) return error;
  if (!isTagged(error)) {
    return new HostError({ code: "Unknown", message: error instanceof Error ? error.message : String(error) });
  }
  const code = error.reason === undefined ? error._tag : `${error._tag}.${error.reason}`;
  const subject = error.sessionId ?? error.provider ?? error.pluginId;
  const retry = retryable(error);
  return new HostError({
    code,
    message: error.message ?? code,
    ...(subject === undefined ? {} : { subject }),
    ...(retry === undefined ? {} : { retryable: retry }),
  });
};

export const toPluginStatus = (snapshot: PluginSnapshot): typeof PluginStatus.Type => {
  const fault = snapshot.fault;
  const cause = fault === undefined ? undefined : Cause.squash(fault.cause);
  return {
    id: snapshot.id,
    ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
    state: snapshot.state,
    ...(fault === undefined ? {} : {
      fault: {
        phase: fault.phase,
        ...(fault.operation === undefined ? {} : { operation: fault.operation }),
        message: `${fault.message}: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    }),
    ...(snapshot.haltedBy === undefined ? {} : { haltedBy: snapshot.haltedBy }),
  };
};

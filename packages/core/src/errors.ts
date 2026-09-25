import { Data, Schema } from "effect";
import type { Cause } from "effect";

export class CompositionError extends Data.TaggedError("CompositionError")<{
  readonly reason:
    | "InvalidId"
    | "DuplicatePlugin"
    | "DuplicateCapability"
    | "ReservedCapability"
    | "MissingCapability"
    | "DependencyCycle"
    | "InvalidConfig";
  readonly message: string;
  readonly plugins: readonly string[];
  readonly capability?: string;
}> {}

/** The original Effect cause retains typed failures, defects, and their stacks. */
export class ActivationError extends Data.TaggedError("ActivationError")<{
  readonly pluginId: string;
  readonly cause: Cause.Cause<unknown>;
}> {
  override get message(): string {
    return `Plugin "${this.pluginId}" failed to activate`;
  }
}

export class CapabilityMismatch extends Data.TaggedError("CapabilityMismatch")<{
  readonly pluginId: string;
  readonly missing: readonly string[];
  readonly undeclared: readonly string[];
}> {
  override get message(): string {
    return `Plugin "${this.pluginId}" exports do not match its declaration (missing: ${this.missing.join(", ") || "none"}; undeclared: ${this.undeclared.join(", ") || "none"})`;
  }
}

export class CoreClosed extends Data.TaggedError("CoreClosed")<{}> {
  override get message(): string {
    return "The core is closing or has closed";
  }
}

export class HookError extends Data.TaggedError("HookError")<{
  readonly reason:
    | "PointConflict"
    | "InvalidOrder"
    | "OwnerClosed"
    | "NextAlreadyCalled"
    | "InvocationEnded";
  readonly hook: string;
  readonly pluginId?: string;
  readonly message: string;
}> {}

/** Where in a plugin's life a failure was observed. */
export const FaultPhase = Schema.Literal(
  "config", "activate", "service", "intercept", "observe", "background", "dispose",
);
export type FaultPhase = typeof FaultPhase.Type;

/**
 * Every failure that crosses a plugin boundary is attributed here by the core;
 * plugin code never constructs one. `deadline` marks a step that ran out of time,
 * which is reported as such and never as a clean stop.
 */
export class PluginFault extends Data.TaggedError("PluginFault")<{
  readonly pluginId: string;
  readonly phase: FaultPhase;
  /** Hook name, event name, background task name, or service operation. */
  readonly operation?: string;
  readonly deadline?: boolean;
  readonly cause: Cause.Cause<unknown>;
}> {
  override get message(): string {
    const where = this.operation === undefined ? this.phase : `${this.phase} ${this.operation}`;
    return `Plugin "${this.pluginId}" failed during ${where}${this.deadline ? " (deadline exceeded)" : ""}`;
  }
}

/** A serializable, actionable message about a composition. Errors block; warnings do not. */
export class Diagnostic extends Schema.Class<Diagnostic>("@basis/core/Diagnostic")({
  severity: Schema.Literal("error", "warning"),
  pluginId: Schema.optional(Schema.String),
  /** Location inside the plugin's config, when the problem is a config value. */
  path: Schema.optional(Schema.Array(Schema.Union(Schema.String, Schema.Number))),
  message: Schema.String,
  suggestion: Schema.optional(Schema.String),
}) {}

/** All problems found while planning a composition change; the running composition is unchanged. */
export class ReloadError extends Data.TaggedError("ReloadError")<{
  readonly diagnostics: readonly Diagnostic[];
}> {
  override get message(): string {
    return this.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n");
  }
}

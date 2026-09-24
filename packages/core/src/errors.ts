import { Data } from "effect";
import type { Cause } from "effect";

export class CompositionError extends Data.TaggedError("CompositionError")<{
  readonly reason:
    | "InvalidId"
    | "DuplicatePlugin"
    | "DuplicateCapability"
    | "ReservedCapability"
    | "MissingCapability"
    | "DependencyCycle";
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

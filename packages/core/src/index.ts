import type { Result } from "../../shared/src";

export const RUNTIME_MODES = ["development", "test", "paper", "live"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface RuntimeConfiguration {
  readonly mode: RuntimeMode;
  /** Phase 1 intentionally has no path that permits live execution. */
  readonly liveExecutionPermitted: false;
}

export function parseRuntimeMode(value: string | undefined): Result<RuntimeMode, "INVALID_RUNTIME_MODE"> {
  if (value !== undefined && (RUNTIME_MODES as readonly string[]).includes(value)) {
    return { ok: true, value: value as RuntimeMode };
  }
  return { ok: false, error: "INVALID_RUNTIME_MODE" };
}

export function resolveRuntimeConfiguration(value: string | undefined): Result<RuntimeConfiguration, "INVALID_RUNTIME_MODE"> {
  const requested = value ?? "development";
  const parsed = parseRuntimeMode(requested);
  return parsed.ok
    ? { ok: true, value: { mode: parsed.value, liveExecutionPermitted: false } }
    : parsed;
}

export function assertLiveExecutionUnavailable(configuration: RuntimeConfiguration): void {
  if (configuration.mode === "live" || !configuration.liveExecutionPermitted) {
    throw new Error("Live execution is unavailable in Phase 1.");
  }
}

export const BOT_STATES = ["stopped", "running", "paused"] as const;
export type BotState = (typeof BOT_STATES)[number];
export type BotCommand = "start" | "pause" | "stop";

export function transitionBotState(state: BotState, command: BotCommand): Result<BotState, "INVALID_BOT_TRANSITION"> {
  const transitions: Record<BotState, Partial<Record<BotCommand, BotState>>> = {
    stopped: { start: "running" },
    running: { pause: "paused", stop: "stopped" },
    paused: { start: "running", stop: "stopped" }
  };
  const next = transitions[state][command];
  return next === undefined ? { ok: false, error: "INVALID_BOT_TRANSITION" } : { ok: true, value: next };
}

export interface AuditEvent {
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId?: string;
  readonly actorId?: string;
  readonly source: "api" | "worker" | "system";
  readonly previousState?: Readonly<Record<string, unknown>>;
  readonly newState?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

export interface AuditLogger {
  append(event: AuditEvent): Promise<void>;
}

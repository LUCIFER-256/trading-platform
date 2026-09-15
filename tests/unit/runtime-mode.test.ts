import { assertLiveExecutionUnavailable, resolveRuntimeConfiguration, transitionBotState } from "../../packages/core/src";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectThrow(action: () => void, message: string): void {
  let threw = false;
  try { action(); } catch { threw = true; }
  assert(threw, message);
}

const development = resolveRuntimeConfiguration(undefined);
assert(development.ok && development.value.mode === "development", "Unset mode must default to development.");
assert(development.ok && development.value.liveExecutionPermitted === false, "Live execution must be fail-closed.");

const recognizedModes = ["development", "test", "paper", "live"] as const;
for (const mode of recognizedModes) {
  const configuration = resolveRuntimeConfiguration(mode);
  assert(configuration.ok, `Recognized mode ${mode} must resolve.`);
  if (configuration.ok) {
    assert(configuration.value.liveExecutionPermitted === false, `${mode} must not authorize live execution.`);
    expectThrow(
      () => assertLiveExecutionUnavailable(configuration.value),
      `${mode} must be rejected by the Phase 1 live-execution guard.`
    );
  }
}

const invalid = resolveRuntimeConfiguration("production");
assert(!invalid.ok && invalid.error === "INVALID_RUNTIME_MODE", "Unknown modes must be rejected.");

const started = transitionBotState("stopped", "start");
assert(started.ok && started.value === "running", "Stopped bot must start.");
assert(!transitionBotState("stopped", "pause").ok, "Invalid bot transitions must be rejected.");

console.log("Runtime-mode unit tests passed.");

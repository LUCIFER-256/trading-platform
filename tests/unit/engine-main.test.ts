import { AdvisoryLockError } from "../../apps/market-data/src/advisory-lock";
import { EngineConfigurationError } from "../../apps/market-data/src/engine-config";
import { STOP_DRAIN_MS } from "../../apps/market-data/src/engine";
import { EXIT_ABORT, EXIT_FAILURE, EXIT_LOCK_HELD, EXIT_OK, failureFields } from "../../apps/market-data/src/main";
import { TermsGateError } from "../../apps/market-data/src/terms-gate";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function unitEntrypointFailureFieldsAreSafe(): void {
  const secret = "postgres://user:sekretpw@host/db";
  for (const error of [new TypeError(secret), new RangeError(secret), new Error(secret), "plain", undefined, { message: secret }]) {
    const fields = failureFields(error);
    assert(!JSON.stringify(fields).includes("sekretpw"), "Unknown failures must never carry their message.");
    assert(!("message" in fields), "Unknown failures must carry a name only.");
  }
  assert(failureFields(new TypeError(secret)).name === "TypeError", "A plain error class name is safe to report.");
  assert(failureFields("plain").name === "UnknownFailure", "A non-error must be reported as unknown.");
  for (const known of [new TermsGateError(), new EngineConfigurationError("LIVE_MODE"), new AdvisoryLockError("UNAVAILABLE")]) {
    const fields = failureFields(known);
    assert(typeof fields.message === "string" && fields.message.length > 0, `${known.name} is a safe class and may report its message.`);
  }
  console.log("unitEntrypointFailureFieldsAreSafe");
}

function unitSupervisorContractIsPinnedToLiterals(): void {
  assert(EXIT_OK === 0, "A clean stop must exit 0.");
  assert(EXIT_FAILURE === 1, "A failed start must exit 1.");
  assert(EXIT_LOCK_HELD === 3, "A held lock must exit 3.");
  assert(EXIT_ABORT === 70, "A lost lock must exit 70.");
  assert(STOP_DRAIN_MS === 1_500, "The shutdown drain window must be 1,500 ms.");
  console.log("unitSupervisorContractIsPinnedToLiterals");
}

unitEntrypointFailureFieldsAreSafe();
unitSupervisorContractIsPinnedToLiterals();

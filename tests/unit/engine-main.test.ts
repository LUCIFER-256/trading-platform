import { AdvisoryLockError } from "../../apps/market-data/src/advisory-lock";
import { EngineConfigurationError } from "../../apps/market-data/src/engine-config";
import { failureFields } from "../../apps/market-data/src/main";
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

unitEntrypointFailureFieldsAreSafe();

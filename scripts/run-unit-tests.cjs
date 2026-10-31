const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const tests = [
  "runtime-mode.test.js",
  "contracts.test.js",
  "database-configuration.test.js",
  "database-client.test.js",
  "migration-policy.test.js",
  "migration-command.test.js",
  "auth.test.js",
  "market-data-contracts.test.js",
  "dependency-cruiser-negative.test.js",
  "dependency-cruiser-lock-negative.test.js",
  "migration-immutability.test.js",
  "market-data-validation.test.js",
  "market-data-circuit.test.js",
  "market-data-queue.test.js",
  "postgres-persistence-port.test.js",
  "market-data-wire-evidence.test.js",
  "market-data-session.test.js",
  "market-data-transport.test.js",
  "advisory-lock.test.js",
  "terms-gate.test.js",
  "market-data-session-recovery.test.js",
  "startup.test.js",
];

for (const test of tests) {
  if (test === "market-data-contracts.test.js") {
    execFileSync("npm", ["run", "check:architecture"], { stdio: "inherit" });
  }
  execFileSync(process.execPath, [join("dist", "tests", "unit", test)], { stdio: "inherit" });
}

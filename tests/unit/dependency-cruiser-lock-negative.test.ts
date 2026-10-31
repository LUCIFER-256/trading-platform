import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function check(): { readonly status: number; readonly output: string } {
  const result = spawnSync("npm", ["run", "check:architecture"], {
    cwd: resolve(__dirname, "../../.."),
    encoding: "utf8",
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const directory = resolve(__dirname, "../../../apps/market-data/src");
const file = join(directory, ".advisory-lock-pg-negative.test.ts");
assert(!existsSync(file), "Advisory lock injection must not already exist.");
const baseline = check();
assert(baseline.status === 0, `Architecture baseline must pass: ${baseline.output}`);
try {
  writeFileSync(file, "import { Client } from 'pg';\nvoid Client;\n");
  const rejected = check();
  assert(rejected.status !== 0, "Architecture must reject a pg import near the advisory lock.");
  assert(
    rejected.output.includes("postgres-drivers-must-remain-inside-database"),
    "Architecture must name the postgres driver rule.",
  );
} finally {
  rmSync(file, { force: true });
}
const clean = check();
assert(clean.status === 0, `Architecture must pass after cleanup: ${clean.output}`);
console.log("dependencyCruiserRejectsAdvisoryLockPgImport");

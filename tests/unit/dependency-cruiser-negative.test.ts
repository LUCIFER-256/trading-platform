import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runArchitectureCheck(): { readonly status: number; readonly output: string } {
  const result = spawnSync("npm", ["run", "check:architecture"], {
    cwd: resolve(__dirname, "../../.."),
    encoding: "utf8"
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

const repositoryRoot = resolve(__dirname, "../../..");
const adapterDirectory = join(repositoryRoot, "apps/market-data/src/coinbase");
const adapterFile = join(adapterDirectory, ".dependency-cruiser-negative-test.ts");
const importerFile = join(repositoryRoot, "packages/strategies/src/.dependency-cruiser-negative-test.ts");

assert(!existsSync(importerFile), "The negative-test importer file must not already exist.");
assert(!existsSync(adapterFile), "The negative-test adapter file must not already exist.");

const adapterDirectoryExisted = existsSync(adapterDirectory);
const baseline = runArchitectureCheck();
assert(baseline.status === 0, `Dependency-cruiser must pass before injection: ${baseline.output}`);

if (!adapterDirectoryExisted) mkdirSync(adapterDirectory, { recursive: true });

try {
  writeFileSync(adapterFile, "export const prohibitedAdapter = true;\n");
  writeFileSync(importerFile, "import { prohibitedAdapter } from '../../../apps/market-data/src/coinbase/.dependency-cruiser-negative-test';\nvoid prohibitedAdapter;\n");
  const rejected = runArchitectureCheck();
  assert(rejected.status !== 0, "Dependency-cruiser must reject the prohibited import.");
  assert(rejected.output.includes("strategies-must-not-depend-on-provider-adapters"), "Dependency-cruiser output must name the provider-adapter rule.");
} finally {
  rmSync(importerFile, { force: true });
  rmSync(adapterFile, { force: true });
  if (!adapterDirectoryExisted) rmdirSync(adapterDirectory);
}

const clean = runArchitectureCheck();
assert(clean.status === 0, `Dependency-cruiser must pass after cleanup: ${clean.output}`);
console.log("dependencyCruiserRejectsStrategyCoinbaseImport");

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

interface PackageJson {
  readonly dependencies?: Record<string, unknown>;
}

interface LockPackage {
  readonly version?: unknown;
  readonly integrity?: unknown;
}

interface Lockfile {
  readonly packages?: Record<string, LockPackage>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const repositoryRoot = path.join(__dirname, "../../..");
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as PackageJson;
const lockfile = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8")) as Lockfile;
const evidencePath = path.join(repositoryRoot, "docs/evidence/ws-8.22.0-npm-audit.txt");
const installedPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/ws/package.json"), "utf8")) as { readonly version?: unknown };
const wsVersion = packageJson.dependencies?.ws;
const lockedWs = lockfile.packages?.["node_modules/ws"];

assert(wsVersion === "8.22.0", "package.json must exact-pin ws@8.22.0.");
assert(lockedWs?.version === "8.22.0", "package-lock.json must lock ws@8.22.0.");
assert(typeof lockedWs?.integrity === "string" && lockedWs.integrity.startsWith("sha512-"), "package-lock.json must contain ws sha512 integrity.");
assert(existsSync(evidencePath), "ws audit evidence must exist.");
assert(readFileSync(evidencePath, "utf8").split(/\r?\n/, 1)[0] === "npm audit", "ws audit evidence must name npm audit on its first line.");
assert(installedPackage.version === "8.22.0", "Installed ws must be version 8.22.0.");

console.log("wsVersionAndAuditEvidenceRecorded");

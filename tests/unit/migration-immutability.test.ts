import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function migrationImmutability(): void {
  const repositoryRoot = resolve(__dirname, "../../..");
  const baseRef = "67d759d";
  const git = spawnSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (git.error !== undefined) {
    console.log(`migrationImmutability skipped: git is unavailable (${git.error.message}).`);
    return;
  }
  if (git.status !== 0) {
    console.log(`migrationImmutability skipped: base ref ${baseRef} is unavailable.`);
    return;
  }

  const check = spawnSync("npm", ["run", "check:migration-immutability", "--", baseRef], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert(check.error === undefined, `Could not run migration immutability check: ${check.error?.message ?? "unknown error"}`);
  assert(check.status === 0, `Migration immutability check failed: ${check.stdout ?? ""}${check.stderr ?? ""}`);
  console.log("migrationImmutability");
}

migrationImmutability();

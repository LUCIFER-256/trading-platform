const { execFileSync } = require("node:child_process");

const baseRef = process.argv[2];
if (typeof baseRef !== "string" || baseRef.length === 0) {
  console.error("A PR merge-base commit/ref is required.");
  process.exitCode = 2;
  return;
}

let changes;
try {
  changes = execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames", `${baseRef}...HEAD`, "--", "packages/database/src/migrations"],
    { encoding: "utf8" }
  ).trim();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Could not compare migrations against base ref "${baseRef}": ${detail}`);
  process.exitCode = 2;
  return;
}

const forbidden = changes.split("\n").filter(Boolean).filter((line) => !line.startsWith("A\t"));
if (forbidden.length > 0) {
  console.error("Existing migration files are immutable. Only added files are allowed:");
  forbidden.forEach((line) => console.error(line));
  process.exitCode = 1;
}

import { createProductionPasswordHasher, createTestPasswordHasher, PRODUCTION_ARGON2ID_PARAMETERS } from "../../apps/api/src/auth";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function main(): Promise<void> {
  const production = createProductionPasswordHasher();
  const hash = await production.hash("production-parameter-smoke-password");
  assert(hash.startsWith("$argon2id$"), "Production hashes must use Argon2id.");
  assert(hash.includes(`m=${PRODUCTION_ARGON2ID_PARAMETERS.memoryCost}`) && hash.includes(`t=${PRODUCTION_ARGON2ID_PARAMETERS.timeCost}`) && hash.includes(`p=${PRODUCTION_ARGON2ID_PARAMETERS.parallelism}`), "Production hashes must encode fixed approved parameters.");
  assert(await production.verify(hash, "production-parameter-smoke-password"), "Production hashes must verify the correct password.");
  assert(!(await production.verify(hash, "wrong-password")), "Production hashes must reject an incorrect password.");
  const testHasher = createTestPasswordHasher(); const testHash = await testHasher.hash("test-password");
  assert(await testHasher.verify(testHash, "test-password"), "Injected test hasher must exercise real Argon2id verification.");
  assert(!testHash.includes(`m=${PRODUCTION_ARGON2ID_PARAMETERS.memoryCost},`), "Test hashing policy must remain separate from production constants.");
  console.log("Authentication unit tests passed.");
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

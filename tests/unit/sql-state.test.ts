import { sqlState } from "../../apps/market-data/src/persistence/sql-state";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function unitSqlStateKeepsOnlyPostgresCodes(): void {
  for (const code of [
    "42501",
    "08006",
    "23514",
    "55000",
    "22023",
    "57P01",
    "P0001",
    "XX000",
    "HV000",
    "28000",
    "3D000",
    "0A000",
    "F0000",
  ]) {
    assert(sqlState({ code }) === code, `${code} is a PostgreSQL SQLSTATE and may be reported.`);
  }
  for (const code of [
    "EPIPE",
    "EBADF",
    "EPERM",
    "ABCDE",
    "ZZZZZ",
    "00 00",
    "4250",
    "425011",
    "42o01",
    "ECONNRESET",
    "",
    "e1234",
  ]) {
    assert(sqlState({ code }) === undefined, `${code} is not a PostgreSQL SQLSTATE and must not be reported.`);
  }
  for (const value of [undefined, null, "42501", 42501, {}, { code: 42501 }, { code: null }, [], () => "42501"]) {
    assert(sqlState(value) === undefined, "A value without a string code must report nothing.");
  }
  console.log("unitSqlStateKeepsOnlyPostgresCodes");
}

unitSqlStateKeepsOnlyPostgresCodes();

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
  const classes = new Set([
    "00",
    "01",
    "02",
    "03",
    "08",
    "09",
    "0A",
    "0B",
    "0F",
    "0L",
    "0P",
    "0Z",
    "20",
    "21",
    "22",
    "23",
    "24",
    "25",
    "26",
    "27",
    "28",
    "2B",
    "2D",
    "2F",
    "34",
    "38",
    "39",
    "3B",
    "3D",
    "3F",
    "40",
    "42",
    "44",
    "53",
    "54",
    "55",
    "57",
    "58",
    "72",
    "F0",
    "HV",
    "P0",
    "XX",
  ]);
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let accepted = 0;
  for (const first of alphabet) {
    for (const second of alphabet) {
      const code = `${first}${second}123`;
      const expected = classes.has(`${first}${second}`);
      assert((sqlState({ code }) === code) === expected, `Class ${first}${second} must be ${expected ? "accepted" : "refused"}.`);
      if (expected) accepted += 1;
    }
  }
  assert(accepted === classes.size, "Every PostgreSQL class must be accepted.");
  console.log("unitSqlStateKeepsOnlyPostgresCodes");
}

unitSqlStateKeepsOnlyPostgresCodes();

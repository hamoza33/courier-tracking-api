import { getJtBulkConcurrency, mapConcurrent } from "./bulk.js";

let passed = 0;
function assert(name: string, value: boolean): void {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed++;
}

assert("default concurrency", getJtBulkConcurrency(undefined) === 5);
assert("lower clamp", getJtBulkConcurrency("0") === 1);
assert("upper clamp", getJtBulkConcurrency("99") === 10);
assert("invalid defaults", getJtBulkConcurrency("wat") === 5);

let active = 0;
let peak = 0;
const values = await mapConcurrent([30, 5, 20, 1, 10], 2, async (delay, index) => {
  active++; peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, delay));
  active--;
  if (index === 3) throw new Error("item failure");
  return index;
});
assert("concurrency limited", peak === 2);
assert("input order preserved", values[0] === 0 && values[1] === 1 && values[2] === 2 && values[4] === 4);
assert("per-item error retained", values[3] instanceof Error && values[3].message === "item failure");
console.log(`Bulk tests: ${passed} passed`);

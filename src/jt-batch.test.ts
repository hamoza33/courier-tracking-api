import { chunkItems } from "./bulk.js";
import { mapJtBatchResponse, trackJtBatch } from "./carriers/jt.js";

let passed = 0;
function assert(name: string, value: boolean): void { if (!value) throw new Error(`FAIL: ${name}`); passed++; }
const chunks = chunkItems(Array.from({ length: 23 }, (_, i) => i), 10);
assert("chunks into 10", chunks.length === 3 && chunks[0].length === 10 && chunks[1].length === 10 && chunks[2].length === 3);
let invalid = false;
try { chunkItems([1], 0); } catch { invalid = true; }
assert("invalid chunk size errors", invalid);
const response = { succ: true, code: 1, data: [
  { keyword: "B", details: [{ scanTime: "2", scanTypeName: "Delivered", customerTracking: "done" }] },
  { keyword: "A", details: [{ scanTime: "1", scanTypeName: "Picked Up", customerTracking: "moving" }] },
] };
const mapped = mapJtBatchResponse(["A", "B", "A", "MISSING"], response);
assert("response order", mapped.map((r) => r.waybillNo).join(",") === "A,B,A,MISSING");
assert("duplicates retained", mapped[0].events.length === 1 && mapped[2].events.length === 1);
assert("missing individual record", !mapped[3].found && mapped[3].events.length === 0);
assert("records matched by keyword", mapped[1].normalizedStatus === "Delivered");
await assertRejects("empty batch errors", trackJtBatch([]), "At least one");
await assertRejects("over ten errors before external call", trackJtBatch(Array.from({ length: 11 }, (_, i) => `JTE${i}`)), "Maximum 10");
console.log(`J&T batch tests: ${passed} passed`);

async function assertRejects(name: string, promise: Promise<unknown>, message: string): Promise<void> {
  try { await promise; } catch (error) { assert(name, error instanceof Error && error.message.includes(message)); return; }
  throw new Error(`FAIL: ${name}`);
}

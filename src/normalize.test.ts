import { normalizeStatus } from "./normalize.js";

// Simple test runner (no external deps needed)
let passed = 0;
let failed = 0;

function assert(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- Delivered ---
assert("iMile delivered", normalizeStatus("Delivered"), "Delivered");
assert("iMile delivered AR", normalizeStatus("تم التسليم"), "Delivered");
assert("J&T sign scan delivered", normalizeStatus("Sign scan", "Package delivered to recipient"), "Delivered");
assert("J&T sign scan returned", normalizeStatus("Sign scan", "The Shipment has been returned to the sender!"), "Returned");
assert("J&T signed", normalizeStatus("Returned signed"), "Returned");
assert("JDW delivered", normalizeStatus("Delivered"), "Delivered");
assert("Naqel delivered", normalizeStatus("Delivered"), "Delivered");

// --- Out for Delivery ---
assert("iMile out for delivery", normalizeStatus("Out for Delivery with Courier"), "Out for Delivery");
assert("Naqel ofd", normalizeStatus("Out For Delivery with Courier"), "Out for Delivery");
assert("J&T delivery scan", normalizeStatus("Delivery scan"), "Out for Delivery");
assert("JDW courier", normalizeStatus("On the way, courier XYZ"), "Out for Delivery");
assert("Injaz delivery", normalizeStatus("Delivery"), "Out for Delivery");

// --- Returned ---
assert("Naqel returned to origin", normalizeStatus("Shipment Returned to Origin"), "Returned");
assert("Naqel returned to facility", normalizeStatus("Shipment Returned to Naqel Facility"), "Returned");
assert("JDW returned to station", normalizeStatus("Return to Station"), "Returned");
assert("J&T returned", normalizeStatus("Returned to logistics"), "Returned");

// --- In Transit ---
assert("iMile in transit", normalizeStatus("In Transit"), "In Transit");
assert("iMile arrived", normalizeStatus("Arrived at Hub"), "In Transit");
assert("Naqel picked up", normalizeStatus("Picked up by Naqel"), "In Transit");
assert("Naqel departed", normalizeStatus("Departed to RIYADH"), "In Transit");
assert("Naqel prepared", normalizeStatus("Prepared for delivery"), "In Transit");
assert("JDW shipped", normalizeStatus("Shipped"), "In Transit");
assert("Injaz processing", normalizeStatus("Processing"), "In Transit");

// --- Edge cases ---
assert("null status", normalizeStatus(null), null);
assert("empty status", normalizeStatus(""), null);
assert("null with description", normalizeStatus(null, "Package delivered to recipient"), "Delivered");
assert("delivery attempted not delivered", normalizeStatus("Delivery attempted"), "In Transit");

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);

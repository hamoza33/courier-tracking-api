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
assert("iMile delivered", normalizeStatus("Delivered", null, "imile"), "Delivered");
assert("iMile delivered AR", normalizeStatus("تم التسليم", null, "imile"), "Delivered");
assert("J&T sign scan delivered", normalizeStatus("Sign scan", "Package delivered to recipient", "jt"), "Delivered");
assert("JDW delivered", normalizeStatus("Delivered", null, "jdw"), "Delivered");
assert("Naqel delivered", normalizeStatus("Delivered", null, "naqel"), "Delivered");
assert("Injaz delivered", normalizeStatus("Delivered", null, "injaz"), "Delivered");

// --- Out for Delivery (applies to every carrier when the latest event is OFD) ---
assert("iMile out for delivery", normalizeStatus("Out for Delivery with Courier", null, "imile"), "Out for Delivery");
assert("Naqel ofd", normalizeStatus("Out For Delivery with Courier", null, "naqel"), "Out for Delivery");
assert("J&T delivery scan", normalizeStatus("Delivery scan", null, "jt"), "Out for Delivery");
assert("JDW courier", normalizeStatus("On the way, courier XYZ", null, "jdw"), "Out for Delivery");
assert("JDW ofd", normalizeStatus("Out for delivery", null, "jdw"), "Out for Delivery");
assert("Injaz delivery", normalizeStatus("Delivery", null, "injaz"), "Out for Delivery");
assert("Injaz ofd", normalizeStatus("Out for delivery", null, "injaz"), "Out for Delivery");

// --- Returned (carrier-specific FINAL return only) ---
// iMile: only "Return Handling Process" counts as returned
assert("iMile return handling process", normalizeStatus("Return Handling Process", null, "imile"), "Returned");
assert("iMile other return text -> in transit", normalizeStatus("Returned to warehouse", null, "imile"), "In Transit");

// JDW: "is ready to return to senders address" is returned; "Return to Station" is another attempt
assert("JDW ready to return to sender", normalizeStatus(null, "The parcel is ready to return to senders address", "jdw"), "Returned");
assert("JDW return to station -> in transit", normalizeStatus("Return to Station", null, "jdw"), "In Transit");

// Naqel: "Shipment Returned to Origin" is returned; "Returned to Naqel Facility" is another attempt
assert("Naqel returned to origin", normalizeStatus("Shipment Returned to Origin", null, "naqel"), "Returned");
assert("Naqel returned to facility -> in transit", normalizeStatus("Shipment Returned to Naqel Facility", null, "naqel"), "In Transit");

// Injaz: "Returned to logistics" is returned; "Not Delivered/Cancel" stays in transit
assert("Injaz returned to logistics", normalizeStatus("Returned to logistics", null, "injaz"), "Returned");
assert("Injaz not delivered/cancel -> in transit", normalizeStatus("Not Delivered/Cancel", "Not Delivered/Cancel", "injaz"), "In Transit");

// J&T: "The Shipment has been returned to the sender" is returned
assert("J&T returned to sender", normalizeStatus("Sign scan", "The Shipment has been returned to the sender!", "jt"), "Returned");
assert("J&T returned signed", normalizeStatus("Returned signed", null, "jt"), "Returned");

// --- In Transit ---
assert("iMile in transit", normalizeStatus("In Transit", null, "imile"), "In Transit");
assert("iMile arrived", normalizeStatus("Arrived at Hub", null, "imile"), "In Transit");
assert("Naqel picked up", normalizeStatus("Picked up by Naqel", null, "naqel"), "In Transit");
assert("Naqel departed", normalizeStatus("Departed to RIYADH", null, "naqel"), "In Transit");
assert("Naqel prepared", normalizeStatus("Prepared for delivery", null, "naqel"), "In Transit");
assert("JDW shipped", normalizeStatus("Shipped", null, "jdw"), "In Transit");
assert("Injaz processing", normalizeStatus("Processing", null, "injaz"), "In Transit");

// --- Edge cases ---
assert("null status", normalizeStatus(null), null);
assert("empty status", normalizeStatus(""), null);
assert("null with description", normalizeStatus(null, "Package delivered to recipient"), "Delivered");
assert("delivery attempted not delivered", normalizeStatus("Delivery attempted", null, "imile"), "In Transit");

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);

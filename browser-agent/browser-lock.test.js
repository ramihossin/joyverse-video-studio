import test from "node:test";
import assert from "node:assert/strict";
import { createOperationGate } from "./browser-lock.js";

test("the gate admits only one browser operation at a time", () => {
  const gate = createOperationGate();
  const first = gate.acquire("click");
  assert.equal(first.label, "click");
  assert.equal(gate.busy, true);
  assert.equal(gate.acquire("screenshot"), null);
  assert.equal(gate.release(first), true);
  assert.equal(gate.busy, false);
});

test("a stale operation cannot release a newer operation", () => {
  const gate = createOperationGate();
  const oldLease = gate.acquire("old task");
  gate.forceRelease();
  const newLease = gate.acquire("new task");
  assert.equal(gate.release(oldLease), false);
  assert.equal(gate.snapshot().label, "new task");
  assert.equal(gate.release(newLease), true);
});

test("recovery can invalidate a running lease and report it", () => {
  const gate = createOperationGate();
  const lease = gate.acquire("stalled page action");
  const cancelled = gate.forceRelease();
  assert.equal(cancelled.label, "stalled page action");
  assert.equal(gate.busy, false);
  assert.equal(gate.release(lease), false);
});

test("the operation snapshot includes elapsed time without exposing mutable state", () => {
  const gate = createOperationGate();
  const lease = gate.acquire("navigation");
  const snapshot = gate.snapshot();
  assert.equal(snapshot.label, "navigation");
  assert.ok(snapshot.elapsedMs >= 0);
  snapshot.label = "changed";
  assert.equal(gate.snapshot().label, "navigation");
  gate.release(lease);
});

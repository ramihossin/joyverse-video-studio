import test from "node:test";
import assert from "node:assert/strict";
import { isRestrictedDestination } from "./url-safety.js";

test("blocks restricted destinations by complete hostname or path segment", () => {
  for (const value of [
    "https://example.test/casino",
    "https://sportsbook.example.test/",
    "https://example.test/poker/live",
    "https://example.test/betting"
  ]) {
    assert.equal(isRestrictedDestination(new URL(value)), true, value);
  }
});

test("blocks restricted multi-word URL categories", () => {
  assert.equal(isRestrictedDestination(new URL("https://example.test/binary/options")), true);
  assert.equal(isRestrictedDestination(new URL("https://example.test/prediction-market")), true);
});

test("does not block harmless words that merely contain a restricted substring", () => {
  for (const value of [
    "https://alphabet.example.test/",
    "https://example.test/better-design",
    "https://example.test/keyboard-shortcuts",
    "https://example.test/market-analysis"
  ]) {
    assert.equal(isRestrictedDestination(new URL(value)), false, value);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { safeDiagnosticUrl, findVerificationHints } from "./browser-utils.js";

test("diagnostic URLs omit query strings and fragments", () => {
  assert.equal(
    safeDiagnosticUrl("https://example.com/login?token=secret#step"),
    "https://example.com/login"
  );
});

test("verification hints identify embedded verification frames", () => {
  assert.deepEqual(
    findVerificationHints(["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget"]),
    { detected: true, frame: true, text: false }
  );
});

test("verification hints identify visible human-check text", () => {
  assert.deepEqual(
    findVerificationHints([], "Please verify that you are human before continuing."),
    { detected: true, frame: false, text: true }
  );
});

test("ordinary pages are not misclassified as verification pages", () => {
  assert.deepEqual(
    findVerificationHints(["https://example.com/embed"], "Welcome to the video generator."),
    { detected: false, frame: false, text: false }
  );
});

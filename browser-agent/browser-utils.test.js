import test from "node:test";
import assert from "node:assert/strict";
import { safeDiagnosticUrl, findVerificationHints, isEditableFocus } from "./browser-utils.js";

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

test("Google automated-browser rejection is detected from its visible message", async () => {
  const { detectGoogleAutomatedBrowserBlock } = await import("./browser-utils.js");
  assert.equal(detectGoogleAutomatedBrowserBlock("This browser or app may not be secure."), true);
  assert.equal(detectGoogleAutomatedBrowserBlock("403 disallowed_useragent"), true);
  assert.equal(detectGoogleAutomatedBrowserBlock("Welcome to the video generator."), false);
});


test("editable focus accepts text inputs, textareas, contenteditable and textboxes", () => {
  assert.equal(isEditableFocus({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isEditableFocus({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableFocus({ tagName: "DIV", contentEditable: true }), true);
  assert.equal(isEditableFocus({ tagName: "DIV", role: "textbox" }), true);
  assert.equal(isEditableFocus({ tagName: "IFRAME" }), false);
});

test("editable focus rejects missing, disabled, read-only and non-text controls", () => {
  assert.equal(isEditableFocus(null), false);
  assert.equal(isEditableFocus({ tagName: "BODY" }), false);
  assert.equal(isEditableFocus({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isEditableFocus({ tagName: "INPUT", type: "text", disabled: true }), false);
  assert.equal(isEditableFocus({ tagName: "TEXTAREA", readOnly: true }), false);
  assert.equal(isEditableFocus({ tagName: "DIV", role: "textbox", ariaReadonly: true }), false);
});

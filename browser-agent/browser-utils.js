export function safeDiagnosticUrl(value) {
  try {
    const url = new URL(String(value));
    return (url.origin + url.pathname).slice(0, 300);
  } catch {
    return "unknown";
  }
}

export function detectGoogleAutomatedBrowserBlock(bodyText = "") {
  const text = String(bodyText).slice(0, 20000);
  return /this browser or app may not be secure|disallowed_useragent|browser may not be secure/i.test(text);
}

export function findVerificationHints(frameUrls = [], bodyText = "") {
  const framePattern = /captcha|turnstile|recaptcha|hcaptcha|challenge-platform/i;
  const textPattern = /verify (?:that )?you are human|checking your browser|complete (?:the )?security check|security verification|human verification/i;
  const frame = frameUrls.some(url => framePattern.test(String(url)));
  const text = textPattern.test(String(bodyText).slice(0, 12000));
  return { detected: frame || text, frame, text };
}


const NON_TEXT_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "hidden", "image",
  "radio", "range", "reset", "submit"
]);

export function isEditableFocus(focus) {
  if (!focus || focus.disabled || focus.readOnly || focus.ariaReadonly) return false;
  const tag = String(focus.tagName || "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = String(focus.type || "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return Boolean(focus.contentEditable) ||
    String(focus.role || "").toLowerCase() === "textbox";
}

export function safeDiagnosticUrl(value) {
  try {
    const url = new URL(String(value));
    return (url.origin + url.pathname).slice(0, 300);
  } catch {
    return "unknown";
  }
}

export function findVerificationHints(frameUrls = [], bodyText = "") {
  const framePattern = /captcha|turnstile|recaptcha|hcaptcha|challenge-platform/i;
  const textPattern = /verify (?:that )?you are human|checking your browser|complete (?:the )?security check|security verification|human verification/i;
  const frame = frameUrls.some(url => framePattern.test(String(url)));
  const text = textPattern.test(String(bodyText).slice(0, 12000));
  return { detected: frame || text, frame, text };
}

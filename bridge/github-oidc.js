import { createPublicKey, verify } from "node:crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = ISSUER + "/.well-known/jwks";
let cachedKeys = new Map();
let cacheExpiresAt = 0;

async function signingKey(kid, fetchImpl, now) {
  if (now >= cacheExpiresAt || !cachedKeys.has(kid)) {
    const response = await fetchImpl(JWKS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error("GitHub OIDC signing keys are unavailable.");
    const jwks = await response.json();
    if (!Array.isArray(jwks.keys)) throw new Error("Invalid GitHub OIDC key set.");
    cachedKeys = new Map(jwks.keys.filter(key => key.kid && key.kty === "RSA" && key.use === "sig")
      .map(key => [key.kid, key]));
    cacheExpiresAt = now + 10 * 60 * 1000;
  }
  const jwk = cachedKeys.get(kid);
  if (!jwk) throw new Error("Unknown GitHub OIDC signing key.");
  return createPublicKey({ key: jwk, format: "jwk" });
}

export async function verifyGithubActionsToken(token, {
  repository,
  workflowFile,
  branch = "main",
  audience = "joyverse-video-worker",
  fetchImpl = fetch,
  now = Date.now()
} = {}) {
  if (typeof token !== "string" || token.length < 100 || token.length > 8192) {
    throw new Error("Missing or invalid GitHub Actions OIDC token.");
  }
  if (!repository || !workflowFile || !branch || !audience) {
    throw new Error("GitHub Actions identity constraints are not configured.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed GitHub Actions OIDC token.");
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed GitHub Actions OIDC token.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Unsupported GitHub Actions token signature.");
  }
  const nowSeconds = Math.floor(now / 1000);
  if (claims.iss !== ISSUER || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds ||
      (claims.nbf !== undefined && claims.nbf > nowSeconds + 30) ||
      (claims.iat !== undefined && claims.iat > nowSeconds + 60)) {
    throw new Error("Expired or invalid GitHub Actions token claims.");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expectedWorkflowRef = `${repository}/${workflowFile}@refs/heads/${branch}`;
  if (!audiences.includes(audience) || claims.repository !== repository ||
      claims.ref !== `refs/heads/${branch}` || claims.workflow_ref !== expectedWorkflowRef) {
    throw new Error("GitHub Actions token is not from the approved repository workflow.");
  }
  const key = await signingKey(header.kid, fetchImpl, now);
  const signed = Buffer.from(parts[0] + "." + parts[1]);
  const signature = Buffer.from(parts[2], "base64url");
  if (!verify("RSA-SHA256", signed, key, signature)) {
    throw new Error("GitHub Actions token signature verification failed.");
  }
  return claims;
}

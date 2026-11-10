import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyGithubActionsToken } from "../bridge/github-oidc.js";

function createToken(privateKey, kid, claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT", kid });
  const payload = encode(claims);
  const signed = header + "." + payload;
  return signed + "." + sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url");
}

test("GitHub OIDC verifier accepts only the configured repository workflow and branch", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "joyverse-test-" + Date.now();
  const now = Date.now();
  const repository = "ramihossin/joyverse-video-studio";
  const workflowFile = ".github/workflows/video-worker.yml";
  const branch = "main";
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "joyverse-video-worker",
    repository,
    ref: "refs/heads/main",
    workflow_ref: repository + "/" + workflowFile + "@refs/heads/main",
    iat: Math.floor(now / 1000),
    nbf: Math.floor(now / 1000) - 5,
    exp: Math.floor(now / 1000) + 300
  };
  const token = createToken(privateKey, kid, claims);
  const fetchImpl = async url => {
    assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks");
    return { ok: true, json: async () => ({ keys: [publicKey.export({ format: "jwk" }).kid
      ? publicKey.export({ format: "jwk" })
      : { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] }) };
  };
  const verified = await verifyGithubActionsToken(token, {
    repository, workflowFile, branch, audience: "joyverse-video-worker", fetchImpl, now
  });
  assert.equal(verified.repository, repository);
  await assert.rejects(verifyGithubActionsToken(token, {
    repository: "another/repository", workflowFile, branch,
    audience: "joyverse-video-worker", fetchImpl, now
  }), /approved repository workflow/);
});

test("GitHub OIDC verifier rejects tampered or expired tokens", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "joyverse-expired-" + Date.now();
  const now = Date.now();
  const repository = "ramihossin/joyverse-video-studio";
  const workflowFile = ".github/workflows/video-worker.yml";
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "joyverse-video-worker", repository, ref: "refs/heads/main",
    workflow_ref: repository + "/" + workflowFile + "@refs/heads/main",
    exp: Math.floor(now / 1000) - 1
  };
  const token = createToken(privateKey, kid, claims);
  await assert.rejects(verifyGithubActionsToken(token, {
    repository, workflowFile, fetchImpl: async () => ({
      ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] })
    }), now
  }), /Expired or invalid/);
});

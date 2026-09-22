import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { readConfig } from "../src/config.js";
import { createFixture } from "./helpers.js";

const frontendOrigin = "https://pro-yiedie.vercel.app";
const untrustedOrigin = "https://untrusted.example";
const productionEnv = {
  NODE_ENV: "production",
  SESSION_SECRET: "tests-only-long-session-secret-do-not-use-in-production",
};

test("cross-site cookie settings accept either case and require production", () => {
  for (const sameSite of ["none", "None"]) {
    assert.equal(
      readConfig({ ...productionEnv, COOKIE_SAME_SITE: sameSite }).sameSite,
      "none",
    );
    assert.throws(
      () => readConfig({
        ...productionEnv,
        NODE_ENV: "development",
        COOKIE_SAME_SITE: sameSite,
      }),
      /COOKIE_SAME_SITE=none requires production HTTPS/,
    );
  }
});

test("Render trusts its proxy by default and respects explicit settings", () => {
  assert.equal(readConfig(productionEnv).trustProxy, 0);
  assert.equal(readConfig({ ...productionEnv, RENDER: "false" }).trustProxy, 0);
  assert.equal(readConfig({ ...productionEnv, RENDER: "true" }).trustProxy, 1);
  for (const trustProxy of ["0", "2"]) {
    assert.equal(
      readConfig({ ...productionEnv, RENDER: "true", TRUST_PROXY: trustProxy }).trustProxy,
      Number(trustProxy),
    );
  }
});

test("Render HTTPS forwarding issues a secure cookie for a CSRF session roundtrip", async (t) => {
  const config = readConfig({ ...productionEnv, RENDER: "true", COOKIE_SAME_SITE: "none" });
  const f = await createFixture(t, config);
  const csrf = await request(f.httpServer)
    .get("/api/auth/csrf")
    .set("Origin", frontendOrigin)
    .set("X-Forwarded-Proto", "https")
    .expect(200);

  assert.equal(csrf.headers["access-control-allow-origin"], frontendOrigin);
  assert.equal(csrf.headers["access-control-allow-credentials"], "true");
  const setCookie = csrf.headers["set-cookie"]?.[0];
  assert.ok(setCookie, "HTTPS requests through Render must receive the session cookie");
  assert.match(setCookie, /; Secure(?:;|$)/);
  assert.match(setCookie, /; HttpOnly(?:;|$)/);
  assert.match(setCookie, /; SameSite=None(?:;|$)/);

  // Supply the secure cookie explicitly because the local test server uses HTTP.
  const cookie = setCookie.split(";")[0];
  const rejected = await request(f.httpServer)
    .post("/api/auth/logout")
    .set("Origin", frontendOrigin)
    .set("X-Forwarded-Proto", "https")
    .set("Cookie", cookie)
    .expect(403);
  assert.equal(rejected.body.error.code, "CSRF_INVALID");

  await request(f.httpServer)
    .post("/api/auth/logout")
    .set("Origin", frontendOrigin)
    .set("X-Forwarded-Proto", "https")
    .set("Cookie", cookie)
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .expect(204);
});

test("API preflights allow the deployed frontend with credentials and CSRF headers", async (t) => {
  const f = await createFixture(t);
  const response = await request(f.httpServer)
    .options("/api/auth/login")
    .set("Origin", frontendOrigin)
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "content-type,x-csrf-token")
    .expect(204);

  assert.equal(response.headers["access-control-allow-origin"], frontendOrigin);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.ok(response.headers["access-control-allow-methods"].split(",").includes("POST"));
  assert.equal(response.headers["access-control-allow-headers"], "content-type,x-csrf-token");
  assert.equal(response.headers["set-cookie"], undefined);

  const denied = await request(f.httpServer)
    .options("/api/auth/login")
    .set("Origin", untrustedOrigin)
    .set("Access-Control-Request-Method", "POST")
    .expect(403);
  assert.equal(denied.body.error.code, "ORIGIN_DENIED");
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});

test("upload responses preserve the allowed origin for credentialed requests", async (t) => {
  const f = await createFixture(t);
  const response = await request(f.httpServer)
    .get("/uploads/cors-test-missing-file.png")
    .set("Origin", frontendOrigin)
    .expect(404);

  assert.equal(response.headers["access-control-allow-origin"], frontendOrigin);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.equal(response.headers["cross-origin-resource-policy"], "cross-origin");
});

test("Socket.IO polling preflights use the same frontend origin allowlist", async (t) => {
  const f = await createFixture(t);
  const path = "/socket.io/?EIO=4&transport=polling";
  const response = await request(f.httpServer)
    .options(path)
    .set("Origin", frontendOrigin)
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "content-type")
    .expect(204);

  assert.equal(response.headers["access-control-allow-origin"], frontendOrigin);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.equal(response.headers["access-control-allow-headers"], "content-type");

  const denied = await request(f.httpServer)
    .options(path)
    .set("Origin", untrustedOrigin)
    .set("Access-Control-Request-Method", "POST");
  assert.ok(denied.status >= 400 && denied.status < 500);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});

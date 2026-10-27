import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signingConsent,
  NATIVE_CONSENT,
  PORTAL_CONSENT,
  LEGACY_GOOGLE_CONSENT,
  signingIdentityProvider,
} from "./signingPolicy.js";
test("evidence never fabricates consent from an omitted or contradictory statement", () => {
  assert.equal(signingConsent(NATIVE_CONSENT), NATIVE_CONSENT);
  assert.equal(signingConsent(PORTAL_CONSENT), PORTAL_CONSENT);
  for (const text of [undefined, "", "No acepto", "Google verified me"])
    assert.throws(() => signingConsent(text));
});

test('legacy Google text is compatible only with an actual Google identity',()=>{assert.equal(signingConsent(LEGACY_GOOGLE_CONSENT,'google.com'),LEGACY_GOOGLE_CONSENT);assert.throws(()=>signingConsent(LEGACY_GOOGLE_CONSENT,'password'));});

test("signing accepts Google and the Google-authenticated GOAT bridge only", () => {
  assert.equal(signingIdentityProvider({ firebase: { sign_in_provider: "google.com" } }), "google.com");
  const bridge = { firebase: { sign_in_provider: "custom" }, goatPortal: true, goatUid: "goat-person", identityProvider: "google.com" };
  assert.equal(signingIdentityProvider(bridge), "google.com");
  for (const token of [
    { firebase: { sign_in_provider: "microsoft.com" } },
    { firebase: { sign_in_provider: "password" }, identityProvider: "google.com" },
    { ...bridge, goatPortal: false },
    { ...bridge, goatUid: "" },
    { ...bridge, identityProvider: "microsoft.com" },
    undefined,
  ]) assert.throws(() => signingIdentityProvider(token));
});

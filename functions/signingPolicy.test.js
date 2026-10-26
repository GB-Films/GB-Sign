import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signingConsent,
  NATIVE_CONSENT,
  PORTAL_CONSENT,
  LEGACY_GOOGLE_CONSENT,
} from "./signingPolicy.js";
test("evidence never fabricates consent from an omitted or contradictory statement", () => {
  assert.equal(signingConsent(NATIVE_CONSENT), NATIVE_CONSENT);
  assert.equal(signingConsent(PORTAL_CONSENT), PORTAL_CONSENT);
  for (const text of [undefined, "", "No acepto", "Google verified me"])
    assert.throws(() => signingConsent(text));
});

test('legacy Google text is compatible only with an actual Google identity',()=>{assert.equal(signingConsent(LEGACY_GOOGLE_CONSENT,'google.com'),LEGACY_GOOGLE_CONSENT);assert.throws(()=>signingConsent(LEGACY_GOOGLE_CONSENT,'microsoft.com'));});

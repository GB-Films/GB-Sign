import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGoatSessionHandler,
  validPortalIdentity,
} from "./goatPortalSession.js";
const token = {
  uid: "goat-user",
  email: "Person@Company.test",
  email_verified: true,
  firebase: { sign_in_provider: "google.com" },
};
test("session bridge accepts only verified Google accounts, without a Gmail suffix requirement", () => {
  assert.equal(validPortalIdentity(token).email, "person@company.test");
  for (const t of [
    { ...token, email_verified: false },
    { ...token, firebase: { sign_in_provider: "password" } },
    { ...token, firebase: { sign_in_provider: "microsoft.com" } },
    { ...token, firebase: { sign_in_provider: "custom" }, identityProvider: "google.com" },
    { ...token, uid: "" },
  ])
    assert.throws(() => validPortalIdentity(t));
});
test("GOAT token must verify before minting and disabled portal creates no session", async () => {
  let minted = 0;
  const deps = {
    verify: async () => token,
    enabled: async () => true,
    findUser: async () => ({ uid: "native-sign-user" }),
    createUser: async () => assert.fail("existing user must be reused"),
    mint: async (uid, claims) => {
      minted++;
      assert.equal(uid, "native-sign-user");
      assert.equal(claims.identityProvider, "google.com");
      assert.equal(claims.goatUid, "goat-user");
      return "short-lived";
    },
  };
  const handler = createGoatSessionHandler(deps);
  assert.deepEqual(await handler({ data: { goatIdToken: "verified" } }), {
    customToken: "short-lived",
  });
  assert.equal(minted, 1);
  await assert.rejects(
    createGoatSessionHandler({ ...deps, enabled: async () => false })({
      data: { goatIdToken: "verified" },
    }),
  );
  assert.equal(minted, 1);
  await assert.rejects(
    createGoatSessionHandler({
      ...deps,
      verify: async () => {
        throw Error("wrong audience");
      },
    })({ data: { goatIdToken: "wrong" } }),
  );
  assert.equal(minted, 1);
  await assert.rejects(
    createGoatSessionHandler({
      ...deps,
      findUser: async () => ({ uid: "native", disabled: true }),
    })({ data: { goatIdToken: "verified" } }),
  );
  assert.equal(minted, 1);
});

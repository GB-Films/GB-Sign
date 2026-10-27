import { initializeApp, getApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export function validPortalIdentity(token) {
  if (
    !token?.uid ||
    !token.email ||
    token.email_verified !== true ||
    token.firebase?.sign_in_provider !== "google.com"
  )
    throw new HttpsError(
      "permission-denied",
      "Ingresá con tu cuenta Google y verificá tu correo.",
    );
  return {
    uid: token.uid,
    email: String(token.email).trim().toLowerCase(),
    provider: token.firebase.sign_in_provider,
    name: String(token.name || "").slice(0, 120),
  };
}
export function createGoatSessionHandler({
  verify,
  enabled,
  findUser,
  createUser,
  mint,
}) {
  return async (request) => {
    const token = request.data?.goatIdToken;
    if (typeof token !== "string" || token.length > 20000)
      throw new HttpsError("invalid-argument", "Falta la sesión de GOAT.");
    const actor = validPortalIdentity(await verify(token));
    if (!(await enabled()))
      throw new HttpsError(
        "failed-precondition",
        "El portal todavía no está habilitado.",
      );
    let user;
    try {
      user = await findUser(actor.email);
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
      try {
        user = await createUser(actor);
      } catch (c) {
        if (c.code !== "auth/email-already-exists") throw c;
        user = await findUser(actor.email);
      }
    }
    if (user.disabled)
      throw new HttpsError(
        "permission-denied",
        "La cuenta de firma está deshabilitada.",
      );
    return {
      customToken: await mint(user.uid, {
        email: actor.email,
        name: actor.name,
        email_verified: true,
        goatPortal: true,
        goatUid: actor.uid,
        identityProvider: actor.provider,
      }),
    };
  };
}
let goat;
function goatApp() {
  if (!goat) {
    try {
      goat = getApp("goat-portal-source");
    } catch {
      goat = initializeApp({ projectId: "gb-goat" }, "goat-portal-source");
    }
  }
  return goat;
}
export const goatSessionHandler = createGoatSessionHandler({
  verify: (token) => getAuth(goatApp()).verifyIdToken(token, true),
  enabled: async () =>
    (
      await getFirestore(goatApp()).doc("providerPortalConfig/current").get()
    ).data()?.enabled === true,
  findUser: (email) => getAuth().getUserByEmail(email),
  createUser: (actor) =>
    getAuth().createUser({ email: actor.email, emailVerified: true }),
  mint: (uid, claims) => getAuth().createCustomToken(uid, claims),
});

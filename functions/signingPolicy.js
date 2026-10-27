import { HttpsError } from "firebase-functions/v2/https";
export function signingIdentityProvider(token) {
  const provider = token?.firebase?.sign_in_provider;
  if (provider === "google.com") return provider;
  if (
    provider === "custom" &&
    token.goatPortal === true &&
    token.identityProvider === "google.com" &&
    typeof token.goatUid === "string" &&
    token.goatUid.length > 0 &&
    token.goatUid.length <= 128
  ) return "google.com";
  throw new HttpsError("permission-denied", "Ingresá con Google para acceder a tus documentos.");
}
export const NATIVE_CONSENT =
  "Declaro que revisé el documento indicado, acepto firmarlo electrónicamente, y entiendo que esta acción registra mi identidad autenticada con la cuenta indicada, fecha, evidencia técnica y vinculación al hash del documento.";
export const PORTAL_CONSENT =
  "Declaro que revisé este documento y acepto firmarlo electrónicamente con mi cuenta verificada, dejando constancia de mi identidad declarada, fecha y evidencia asociada al documento.";
export const LEGACY_GOOGLE_CONSENT =
  "Declaro que revisé el documento indicado, acepto firmarlo electrónicamente, y entiendo que esta acción registra mi identidad autenticada por Google, fecha, evidencia técnica y vinculación al hash del documento.";
export function signingConsent(value, provider) {
  if (
    ![NATIVE_CONSENT, PORTAL_CONSENT].includes(value) &&
    !(provider === "google.com" && value === LEGACY_GOOGLE_CONSENT)
  )
    throw new HttpsError(
      "invalid-argument",
      "Tenés que aceptar expresamente el consentimiento de firma vigente.",
    );
  return value;
}

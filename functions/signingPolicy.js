import { HttpsError } from "firebase-functions/v2/https";
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

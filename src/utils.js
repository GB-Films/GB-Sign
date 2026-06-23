export function normalizeEmail(value = '') {
  return value.trim().toLowerCase();
}

export function parseEmails(value = '') {
  return [...new Set(value.split(/[\n,; ]+/).map(normalizeEmail).filter(Boolean))];
}

export async function sha256File(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fmtDate(value) {
  if (!value) return '-';
  const date = value?.toDate ? value.toDate() : new Date(value);
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function statusFor(doc, signatures = []) {
  const signedEmails = new Set(signatures.map((s) => s.email));
  const total = doc.signerEmails?.length || 0;
  const signed = (doc.signerEmails || []).filter((e) => signedEmails.has(e)).length;
  if (!total) return 'Sin firmantes';
  if (signed === total) return 'Completo';
  if (signed > 0) return `${signed}/${total} firmado`;
  return 'Pendiente';
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

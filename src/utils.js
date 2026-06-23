export function normalizeEmail(value = '') {
  return value.trim().toLowerCase();
}

export function parseEmails(value = '') {
  return [...new Set(value.split(/[\n,; ]+/).map(normalizeEmail).filter(Boolean))];
}

export function emailKey(value = '') {
  return normalizeEmail(value).replace(/[^a-z0-9]/g, '_');
}

export function signatureRequestId(projectId, docId, signerEmail) {
  return `${projectId}_${docId}_${emailKey(signerEmail)}`;
}

export async function sha256Bytes(bytes) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer || bytes;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256File(file) {
  const buffer = await file.arrayBuffer();
  return sha256Bytes(buffer);
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

export function downloadBytes(filename, bytes, type = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadText(filename, text, type = 'text/plain') {
  downloadBytes(filename, text, type);
}

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const db = getFirestore();
const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'gb-sign-e1776.firebasestorage.app';
const bucket = getStorage().bucket(bucketName);

const ACCEPTANCE_TEXT = 'Declaro que revisé el documento indicado, acepto firmarlo electrónicamente, y entiendo que esta acción registra mi identidad autenticada por Google, fecha, evidencia técnica y vinculación al hash del documento.';

export const signDocument = onCall({ timeoutSeconds: 120, memory: '1GiB' }, async (request) => {
  const auth = requireAuth(request);
  const data = request.data || {};
  const projectId = cleanId(data.projectId, 'projectId');
  const docId = cleanId(data.docId, 'docId');
  const requestId = String(data.requestId || signatureRequestId(projectId, docId, auth.email));
  const fieldId = String(data.fieldId || '');
  const signatureType = String(data.signatureType || '');
  const dni = normalizeDni(data.dni);
  const typedName = String(data.typedName || '').trim().slice(0, 120);
  const signatureImage = String(data.signatureImage || '');
  const acceptedText = String(data.acceptedText || ACCEPTANCE_TEXT).slice(0, 2000);
  const clientEvidence = sanitizeClientEvidence(data.clientEvidence || {});

  if (!dni || dni.length < 6) throw new HttpsError('invalid-argument', 'El DNI debe tener entre 6 y 12 números.');
  if (!['drawn', 'typed'].includes(signatureType)) throw new HttpsError('invalid-argument', 'Tipo de firma inválido.');
  if (signatureType === 'typed' && !typedName) throw new HttpsError('invalid-argument', 'Falta el nombre para la firma cursiva.');
  if (signatureType === 'drawn' && !isPngDataUrl(signatureImage)) throw new HttpsError('invalid-argument', 'Falta una firma dibujada válida en PNG.');

  const projectRef = db.collection('projects').doc(projectId);
  const docRef = projectRef.collection('documents').doc(docId);
  const requestRef = db.collection('signatureRequests').doc(requestId);
  const signatureRef = docRef.collection('signatures').doc(auth.uid);
  const signedAt = new Date();

  await db.runTransaction(async (tx) => {
    const [projectSnap, docSnap, reqSnap, signatureSnap] = await Promise.all([
      tx.get(projectRef),
      tx.get(docRef),
      tx.get(requestRef),
      tx.get(signatureRef),
    ]);

    if (!projectSnap.exists) throw new HttpsError('not-found', 'El proyecto no existe.');
    if (!docSnap.exists) throw new HttpsError('not-found', 'El documento no existe.');
    if (!reqSnap.exists) throw new HttpsError('permission-denied', 'No existe una solicitud de firma para este usuario.');
    if (signatureSnap.exists) throw new HttpsError('already-exists', 'Este usuario ya firmó este documento.');

    const docu = { id: docSnap.id, ...docSnap.data() };
    const req = reqSnap.data() || {};
    const signerEmails = (docu.signerEmails || []).map(normalizeEmail);
    if (!signerEmails.includes(auth.email)) throw new HttpsError('permission-denied', 'Tu email autenticado no está asignado como firmante.');
    if (normalizeEmail(req.signerEmail || '') !== auth.email || req.projectId !== projectId || req.docId !== docId) {
      throw new HttpsError('permission-denied', 'La solicitud de firma no corresponde a este documento o firmante.');
    }

    const field = (docu.signatureFields || []).find((f) => String(f.id || '') === fieldId && normalizeEmail(f.signerEmail || '') === auth.email);
    if (!field) throw new HttpsError('permission-denied', 'El campo de firma no corresponde a este firmante.');

    const signaturePayload = {
      uid: auth.uid,
      email: auth.email,
      displayName: auth.name || '',
      dni,
      dniEntered: String(data.dniEntered || data.dni || '').slice(0, 30),
      dniConfirmed: true,
      identityStatement: `El firmante declaró y confirmó DNI ${dni} al momento de firmar.`,
      documentSha256: docu.sha256 || '',
      fieldId,
      signatureField: field,
      signatureType,
      signatureImage: signatureType === 'drawn' ? signatureImage : '',
      typedName: signatureType === 'typed' ? typedName : '',
      renderedSignature: signatureType === 'typed' ? typedName : signatureImage,
      consentElectronicSignature: true,
      intentAction: 'El firmante abrió el documento, presionó su campo de firma asignado, declaró su DNI, aceptó el consentimiento y confirmó la firma electrónica.',
      acceptedText,
      authProvider: 'google.com via Firebase Authentication',
      authUid: auth.uid,
      authEmailVerified: Boolean(request.auth?.token?.email_verified),
      serverVerified: true,
      serverFunction: 'signDocument',
      clientEvidence,
      userAgent: clientEvidence.userAgent || '',
      ipAddress: getIp(request),
      signedAt: FieldValue.serverTimestamp(),
      signedAtIso: signedAt.toISOString(),
      createdAt: FieldValue.serverTimestamp(),
    };

    tx.create(signatureRef, signaturePayload);
    tx.set(requestRef, {
      status: 'signed',
      signedAt: FieldValue.serverTimestamp(),
      signedAtIso: signedAt.toISOString(),
      signedByUid: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.update(docRef, {
      lastSignatureAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      evidenceVersion: 'server-v1',
    });
  });

  const artifacts = await generateArtifacts(projectId, docId, {
    generatedByUid: auth.uid,
    generatedByEmail: auth.email,
    reason: 'signDocument',
  });

  return { ok: true, ...artifacts };
});

export const generateDocumentArtifacts = onCall({ timeoutSeconds: 120, memory: '1GiB' }, async (request) => {
  const auth = requireAuth(request);
  const data = request.data || {};
  const projectId = cleanId(data.projectId, 'projectId');
  const docId = cleanId(data.docId, 'docId');
  await assertCanGenerate(auth, projectId, docId);
  const artifacts = await generateArtifacts(projectId, docId, {
    generatedByUid: auth.uid,
    generatedByEmail: auth.email,
    reason: 'manualGenerateDocumentArtifacts',
  });
  return { ok: true, ...artifacts };
});

async function assertCanGenerate(auth, projectId, docId) {
  const [adminSnap, projectSnap, docSnap] = await Promise.all([
    db.collection('admins').doc(auth.uid).get(),
    db.collection('projects').doc(projectId).get(),
    db.collection('projects').doc(projectId).collection('documents').doc(docId).get(),
  ]);
  if (!projectSnap.exists || !docSnap.exists) throw new HttpsError('not-found', 'Proyecto o documento inexistente.');
  const project = projectSnap.data() || {};
  const docu = docSnap.data() || {};
  const collaboratorEmails = (project.collaboratorEmails || []).map(normalizeEmail);
  const signerEmails = (docu.signerEmails || []).map(normalizeEmail);
  const allowed = adminSnap.exists || project.ownerUid === auth.uid || collaboratorEmails.includes(auth.email) || signerEmails.includes(auth.email);
  if (!allowed) throw new HttpsError('permission-denied', 'No tenés permisos para generar los PDFs de evidencia de este documento.');
}

async function generateArtifacts(projectId, docId, context) {
  const projectRef = db.collection('projects').doc(projectId);
  const docRef = projectRef.collection('documents').doc(docId);
  const [projectSnap, docSnap, sigSnap] = await Promise.all([
    projectRef.get(),
    docRef.get(),
    docRef.collection('signatures').get(),
  ]);
  if (!projectSnap.exists || !docSnap.exists) throw new HttpsError('not-found', 'Proyecto o documento inexistente.');
  const project = { id: projectSnap.id, ...projectSnap.data() };
  const docu = { id: docSnap.id, projectId, ...docSnap.data() };
  const signatures = sigSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!signatures.length) throw new HttpsError('failed-precondition', 'El documento todavía no tiene firmas.');
  if (!docu.storagePath) throw new HttpsError('failed-precondition', 'El documento no tiene archivo asociado en Storage.');

  const [originalBuffer] = await bucket.file(docu.storagePath).download();
  const originalSha256 = sha256(originalBuffer);
  if (docu.sha256 && originalSha256 !== docu.sha256) {
    throw new HttpsError('failed-precondition', 'El hash del archivo actual no coincide con el hash guardado. No se generan artefactos.');
  }

  const signedPdfBytes = await buildSignedPdf({ originalBytes: originalBuffer, project, docu, signatures, originalSha256, context });
  const signedPdfSha256 = sha256(Buffer.from(signedPdfBytes));
  const certificateBytes = await buildEvidenceCertificatePdf({ project, docu, signatures, originalSha256, signedPdfSha256, context });
  const certificateSha256 = sha256(Buffer.from(certificateBytes));

  const base = `projects/${projectId}/artifacts/${docId}`;
  const signedPdfPath = `${base}/${safeFileName(docu.title || docu.fileName || 'documento')}-firmado-gb-sign.pdf`;
  const certificatePdfPath = `${base}/${safeFileName(docu.title || docu.fileName || 'documento')}-certificado-evidencia-gb-sign.pdf`;

  await Promise.all([
    bucket.file(signedPdfPath).save(Buffer.from(signedPdfBytes), {
      resumable: false,
      contentType: 'application/pdf',
      metadata: { metadata: { projectId, docId, artifactType: 'signedPdf', originalSha256, signedPdfSha256, generatedByUid: context.generatedByUid || '' } },
    }),
    bucket.file(certificatePdfPath).save(Buffer.from(certificateBytes), {
      resumable: false,
      contentType: 'application/pdf',
      metadata: { metadata: { projectId, docId, artifactType: 'evidenceCertificate', originalSha256, signedPdfSha256, certificateSha256, generatedByUid: context.generatedByUid || '' } },
    }),
  ]);

  const signedEmails = signatures.map((s) => normalizeEmail(s.email));
  const signerEmails = (docu.signerEmails || []).map(normalizeEmail);
  const allSigned = signerEmails.length > 0 && signerEmails.every((e) => signedEmails.includes(e));

  await docRef.set({
    status: allSigned ? 'completed' : 'partially_signed',
    serverArtifacts: {
      signedPdfPath,
      certificatePdfPath,
      originalSha256,
      signedPdfSha256,
      certificateSha256,
      generatedAt: FieldValue.serverTimestamp(),
      generatedAtIso: new Date().toISOString(),
      generatedByUid: context.generatedByUid || '',
      generatedByEmail: context.generatedByEmail || '',
      generator: 'Cloud Functions / pdf-lib',
      evidenceVersion: 'server-v1',
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('artifactEvents').add({
    projectId,
    docId,
    signedPdfPath,
    certificatePdfPath,
    originalSha256,
    signedPdfSha256,
    certificateSha256,
    generatedByUid: context.generatedByUid || '',
    generatedByEmail: context.generatedByEmail || '',
    reason: context.reason || '',
    createdAt: FieldValue.serverTimestamp(),
  });

  return { signedPdfPath, certificatePdfPath, originalSha256, signedPdfSha256, certificateSha256, status: allSigned ? 'completed' : 'partially_signed' };
}

async function buildSignedPdf({ originalBytes, project, docu, signatures, originalSha256, context }) {
  const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
  const fonts = await loadPdfFonts(pdfDoc);
  pdfDoc.setTitle(`${docu.title || docu.fileName || 'Documento'} - firmado electrónicamente por GB Sign`);
  pdfDoc.setSubject('PDF con firmas electrónicas visuales y certificado de evidencia generado en servidor por GB Sign.');
  pdfDoc.setKeywords(['GB Sign', 'firma electrónica', 'evidencia', originalSha256 || '']);
  pdfDoc.setProducer('GB Sign Cloud Functions');
  pdfDoc.setCreator('GB Sign');
  pdfDoc.setModificationDate(new Date());

  for (const sig of signatures) {
    const field = sig.signatureField || (docu.signatureFields || []).find((f) => f.id === sig.fieldId || normalizeEmail(f.signerEmail) === normalizeEmail(sig.email));
    if (!field) continue;
    const pageIndex = Math.max(0, Math.min(pdfDoc.getPageCount() - 1, Number(field.page || 1) - 1));
    const page = pdfDoc.getPage(pageIndex);
    await drawSignatureStamp(pdfDoc, page, field, sig, fonts);
  }

  await appendEvidencePages(pdfDoc, { project, docu, signatures, originalSha256, signedPdfSha256: '', fonts, context, includeLegalNote: true });
  return pdfDoc.save();
}

async function buildEvidenceCertificatePdf({ project, docu, signatures, originalSha256, signedPdfSha256, context }) {
  const pdfDoc = await PDFDocument.create();
  const fonts = await loadPdfFonts(pdfDoc);
  pdfDoc.setTitle(`${docu.title || docu.fileName || 'Documento'} - certificado de evidencia GB Sign`);
  pdfDoc.setSubject('Certificado de evidencia de firma electrónica generado en servidor por GB Sign.');
  pdfDoc.setKeywords(['GB Sign', 'firma electrónica', 'certificado de evidencia', originalSha256 || '', signedPdfSha256 || '']);
  pdfDoc.setProducer('GB Sign Cloud Functions');
  pdfDoc.setCreator('GB Sign');
  pdfDoc.setCreationDate(new Date());
  await appendEvidencePages(pdfDoc, { project, docu, signatures, originalSha256, signedPdfSha256, fonts, context, includeLegalNote: true });
  return pdfDoc.save();
}

async function loadPdfFonts(pdfDoc) {
  return {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
  };
}

async function drawSignatureStamp(pdfDoc, page, field, sig, fonts) {
  const { width, height } = page.getSize();
  const x = Number(field.x || 0) * width;
  const boxW = Math.max(70, Number(field.w || 0.2) * width);
  const boxH = Math.max(34, Number(field.h || 0.08) * height);
  const y = height - (Number(field.y || 0) * height) - boxH;
  const pad = Math.max(3, Math.min(8, boxH * 0.12));
  const metaH = Math.min(28, Math.max(16, boxH * 0.34));

  page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: rgb(0.08, 0.08, 0.08), borderWidth: 0.9, color: rgb(1, 1, 1), opacity: 0.94 });
  page.drawLine({ start: { x: x + pad, y: y + metaH + 1 }, end: { x: x + boxW - pad, y: y + metaH + 1 }, thickness: 0.6, color: rgb(0.1, 0.1, 0.1) });

  const signatureAreaH = Math.max(8, boxH - metaH - pad * 1.5);
  if (sig.signatureType === 'drawn' && sig.signatureImage) {
    try {
      const png = await pdfDoc.embedPng(dataUrlToBuffer(sig.signatureImage));
      const dims = fitImage(png, boxW - pad * 2, signatureAreaH);
      page.drawImage(png, { x: x + (boxW - dims.width) / 2, y: y + metaH + 4 + Math.max(0, (signatureAreaH - dims.height) / 2), width: dims.width, height: dims.height });
    } catch {
      page.drawText(sig.displayName || sig.typedName || sig.email || 'Firma', { x: x + pad, y: y + metaH + signatureAreaH * 0.35, size: Math.min(22, signatureAreaH * 0.55), font: fonts.italic, color: rgb(0.05, 0.05, 0.05), maxWidth: boxW - pad * 2 });
    }
  } else {
    page.drawText(sig.typedName || sig.displayName || sig.email || 'Firma', { x: x + pad, y: y + metaH + signatureAreaH * 0.32, size: Math.min(24, Math.max(10, signatureAreaH * 0.55)), font: fonts.italic, color: rgb(0.05, 0.05, 0.05), maxWidth: boxW - pad * 2 });
  }

  const line1 = `${sig.displayName || sig.typedName || 'Firmante'} · DNI ${sig.dni || '-'}`;
  const line2 = `${sig.email || '-'} · ${compactDate(sig)}`;
  page.drawText(line1.slice(0, 120), { x: x + pad, y: y + metaH - 10, size: Math.min(7.6, Math.max(5.5, metaH * 0.28)), font: fonts.bold, color: rgb(0.08, 0.08, 0.08), maxWidth: boxW - pad * 2 });
  page.drawText(line2.slice(0, 140), { x: x + pad, y: y + 4, size: Math.min(6.8, Math.max(5, metaH * 0.24)), font: fonts.regular, color: rgb(0.18, 0.18, 0.18), maxWidth: boxW - pad * 2 });
}

async function appendEvidencePages(pdfDoc, { project, docu, signatures, originalSha256, signedPdfSha256, fonts, context, includeLegalNote = true }) {
  const margin = 42;
  let page = pdfDoc.addPage([595.28, 841.89]);
  let y = 792;

  const newPage = () => { page = pdfDoc.addPage([595.28, 841.89]); y = 792; };
  const ensure = (needed = 80) => { if (y < margin + needed) newPage(); };
  const text = (value, opts = {}) => {
    const size = opts.size || 10;
    const font = opts.bold ? fonts.bold : opts.italic ? fonts.italic : fonts.regular;
    const color = opts.color || rgb(0.08, 0.08, 0.08);
    const lines = wrapText(String(value ?? ''), opts.maxChars || 92);
    for (const line of lines) {
      ensure(size + 6);
      page.drawText(line, { x: opts.x || margin, y, size, font, color, maxWidth: 510 });
      y -= size + 5;
    }
  };
  const row = (label, value) => {
    ensure(28);
    page.drawText(label, { x: margin, y, size: 9, font: fonts.bold, color: rgb(0.16, 0.16, 0.16), maxWidth: 135 });
    const lines = wrapText(String(value ?? '-'), 74);
    for (const line of lines) {
      page.drawText(line, { x: margin + 145, y, size: 9, font: fonts.regular, color: rgb(0.08, 0.08, 0.08), maxWidth: 365 });
      y -= 13;
    }
    y -= 3;
  };

  page.drawText('GB Sign', { x: margin, y: 805, size: 16, font: fonts.bold, color: rgb(0.02, 0.02, 0.02) });
  page.drawText('Certificado de evidencia de firma electrónica', { x: margin, y: 780, size: 20, font: fonts.bold, color: rgb(0.02, 0.02, 0.02) });
  y = 746;

  text('Este certificado fue generado por una Cloud Function de Firebase después de verificar la sesión autenticada del firmante y los permisos asociados al documento.', { size: 10, maxChars: 88 });
  y -= 8;

  row('Proyecto', `${project.name || '-'}${project.client ? ` · ${project.client}` : ''}`);
  row('Documento', `${docu.title || '-'} · ${docu.fileName || '-'}`);
  row('ID documento', docu.id || '-');
  row('Hash SHA-256 original', originalSha256 || docu.sha256 || '-');
  if (signedPdfSha256) row('Hash PDF firmado', signedPdfSha256);
  row('Generado por', `${context?.generatedByEmail || '-'} · UID ${context?.generatedByUid || '-'}`);
  row('Fecha generación', new Intl.DateTimeFormat('es-AR', { dateStyle: 'full', timeStyle: 'long', timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date()) + ' (Argentina)');
  row('Motor de generación', 'Firebase Cloud Functions + Firebase Admin SDK + pdf-lib');
  row('Cantidad de firmantes', `${signatures.length} firma(s) registradas de ${(docu.signerEmails || []).length} firmante(s) solicitados.`);

  if (includeLegalNote) {
    y -= 8;
    text('Nota legal operativa', { size: 12, bold: true, maxChars: 88 });
    text('GB Sign registra firmas electrónicas con evidencia de autenticación Google/Firebase, intención, consentimiento, DNI declarado, hash de integridad del documento, fecha/hora de servidor y generación de artefactos por backend. No reemplaza una firma digital certificada con autoridad certificante.', { size: 9, maxChars: 94 });
  }

  y -= 10;
  text('Detalle de firmas', { size: 14, bold: true, maxChars: 88 });

  for (const [index, sig] of signatures.entries()) {
    ensure(250);
    page.drawRectangle({ x: margin, y: y - 6, width: 511, height: 1, color: rgb(0.88, 0.88, 0.88) });
    y -= 24;
    text(`Firma ${index + 1}: ${sig.displayName || sig.typedName || sig.email || 'Firmante'}`, { size: 12, bold: true, maxChars: 88 });
    row('Email autenticado', sig.email || '-');
    row('UID Firebase', sig.uid || sig.authUid || '-');
    row('Email verificado', sig.authEmailVerified ? 'Sí, reportado por Firebase Auth/Google' : 'No informado');
    row('DNI declarado', sig.dni ? `${sig.dni} (${sig.dniConfirmed ? 'confirmado por el firmante' : 'sin confirmación'})` : '-');
    row('Fecha y hora servidor', signedAtText(sig));
    row('Tipo de firma', sig.signatureType === 'drawn' ? 'Firma dibujada con mouse/touch' : 'Firma cursiva generada con nombre');
    row('Hash firmado', sig.documentSha256 || docu.sha256 || '-');
    row('Campo visual', sig.fieldId || sig.signatureField?.id || '-');
    row('IP registrada', sig.ipAddress || '-');
    row('User agent', sig.userAgent || sig.clientEvidence?.userAgent || '-');
    row('Acción de intención', sig.intentAction || '-');
    row('Texto aceptado', sig.acceptedText || ACCEPTANCE_TEXT);

    ensure(82);
    page.drawText('Representación visual de la firma:', { x: margin, y, size: 9, font: fonts.bold, color: rgb(0.12, 0.12, 0.12) });
    y -= 68;
    page.drawRectangle({ x: margin, y, width: 220, height: 56, borderColor: rgb(0.18, 0.18, 0.18), borderWidth: 0.8, color: rgb(1, 1, 1), opacity: 0.95 });
    if (sig.signatureType === 'drawn' && sig.signatureImage) {
      try {
        const png = await pdfDoc.embedPng(dataUrlToBuffer(sig.signatureImage));
        const dims = fitImage(png, 204, 46);
        page.drawImage(png, { x: margin + 8 + (204 - dims.width) / 2, y: y + 5 + (46 - dims.height) / 2, width: dims.width, height: dims.height });
      } catch {
        page.drawText('Firma dibujada registrada', { x: margin + 10, y: y + 23, size: 12, font: fonts.italic });
      }
    } else {
      page.drawText(sig.typedName || sig.displayName || sig.email || 'Firma', { x: margin + 10, y: y + 22, size: 21, font: fonts.italic, color: rgb(0.04, 0.04, 0.04), maxWidth: 200 });
    }
    y -= 22;
  }
}

function requireAuth(request) {
  if (!request.auth?.uid || !request.auth?.token?.email) throw new HttpsError('unauthenticated', 'Tenés que iniciar sesión con Google para firmar.');
  return { uid: request.auth.uid, email: normalizeEmail(request.auth.token.email), name: request.auth.token.name || '' };
}
function cleanId(value, name) {
  const v = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(v)) throw new HttpsError('invalid-argument', `${name} inválido.`);
  return v;
}
function normalizeEmail(value = '') { return String(value || '').trim().toLowerCase(); }
function emailKey(value = '') { return normalizeEmail(value).replace(/[^a-z0-9]/g, '_'); }
function signatureRequestId(projectId, docId, signerEmail) { return `${projectId}_${docId}_${emailKey(signerEmail)}`; }
function normalizeDni(value = '') { return String(value || '').replace(/\D/g, '').slice(0, 12); }
function isPngDataUrl(value = '') { return /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(value || '')) && String(value).length < 800000; }
function sanitizeClientEvidence(v) {
  return {
    userAgent: String(v.userAgent || '').slice(0, 500),
    timezone: String(v.timezone || '').slice(0, 80),
    language: String(v.language || '').slice(0, 40),
    screen: {
      width: Number(v.screen?.width || 0) || null,
      height: Number(v.screen?.height || 0) || null,
      pixelRatio: Number(v.screen?.pixelRatio || 1) || 1,
    },
  };
}
function getIp(request) {
  const forwarded = request.rawRequest?.headers?.['x-forwarded-for'];
  if (Array.isArray(forwarded)) return forwarded[0]?.split(',')[0]?.trim() || '';
  return String(forwarded || request.rawRequest?.ip || '').split(',')[0].trim().slice(0, 80);
}
function sha256(bytes) { return createHash('sha256').update(Buffer.from(bytes)).digest('hex'); }
function dataUrlToBuffer(dataUrl = '') { return Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'); }
function fitImage(image, maxWidth, maxHeight) { const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1); return { width: image.width * scale, height: image.height * scale }; }
function signedAtDate(sig) { return sig?.signedAt?.toDate ? sig.signedAt.toDate() : sig?.signedAtIso ? new Date(sig.signedAtIso) : sig?.signedAt ? new Date(sig.signedAt) : null; }
function signedAtText(sig) { const d = signedAtDate(sig); if (!d || Number.isNaN(d.getTime())) return 'Fecha no disponible'; return new Intl.DateTimeFormat('es-AR', { dateStyle: 'full', timeStyle: 'long', timeZone: 'America/Argentina/Buenos_Aires' }).format(d) + ' (Argentina)'; }
function compactDate(sig) { const d = signedAtDate(sig); if (!d || Number.isNaN(d.getTime())) return 'fecha no disponible'; return new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(d); }
function safeFileName(value = 'documento') { return String(value || 'documento').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'documento'; }
function wrapText(value, maxChars = 90) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) { lines.push(line); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc, collection, doc, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  CheckCircle2, ClipboardCopy, Download, FileSignature, FolderPlus,
  LockKeyhole, LogOut, PenLine, Settings, ShieldCheck, Upload, Users
} from 'lucide-react';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { auth, db, provider, storage } from './firebase';
import { Badge, Button, Card, Empty, Field } from './components.jsx';
import {
  downloadBytes, downloadText, emailKey, fmtDate, normalizeEmail, parseEmails,
  sha256Bytes, sha256File, signatureRequestId, statusFor
} from './utils.js';

const ACCEPTANCE_TEXT = 'Declaro que revisé el documento indicado, acepto firmarlo electrónicamente, y entiendo que esta acción registra mi identidad autenticada por Google, fecha, evidencia técnica y vinculación al hash del documento.';

function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    setLoading(false);
    if (u) {
      await setDoc(doc(db, 'users', u.uid), {
        uid: u.uid,
        email: normalizeEmail(u.email),
        displayName: u.displayName || '',
        photoURL: u.photoURL || '',
        lastLoginAt: serverTimestamp(),
      }, { merge: true });
    }
  }), []);
  return { user, loading };
}

function useAdmin(user) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loadingAdmin, setLoadingAdmin] = useState(true);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      setLoadingAdmin(false);
      return;
    }
    setLoadingAdmin(true);
    return onSnapshot(doc(db, 'admins', user.uid), (snap) => {
      setIsAdmin(snap.exists());
      setLoadingAdmin(false);
    }, () => {
      setIsAdmin(false);
      setLoadingAdmin(false);
    });
  }, [user]);

  return { isAdmin, loadingAdmin };
}

export default function App() {
  const { user, loading } = useAuth();
  const { isAdmin, loadingAdmin } = useAdmin(user);
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [documents, setDocuments] = useState([]);
  const [pending, setPending] = useState([]);
  const [signaturesByDoc, setSignaturesByDoc] = useState({});

  useEffect(() => {
    if (!user) return;
    const ownedQ = query(collection(db, 'projects'), where('ownerUid', '==', user.uid));
    const sharedQ = query(collection(db, 'projects'), where('collaboratorEmails', 'array-contains', normalizeEmail(user.email)));
    const cache = new Map();
    const publish = () => setProjects([...cache.values()].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    const onErr = (err) => console.warn('No se pudieron cargar proyectos:', err.message);
    const unsubOwned = onSnapshot(ownedQ, (snap) => { snap.docs.forEach((d) => cache.set(d.id, { id: d.id, ...d.data() })); publish(); }, onErr);
    const unsubShared = onSnapshot(sharedQ, (snap) => { snap.docs.forEach((d) => cache.set(d.id, { id: d.id, ...d.data() })); publish(); }, onErr);
    return () => { unsubOwned(); unsubShared(); };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'signatureRequests'), where('signerEmail', '==', normalizeEmail(user.email)));
    return onSnapshot(q, (snap) => {
      setPending(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    }, (err) => console.warn('No se pudieron cargar firmas pendientes:', err.message));
  }, [user]);

  useEffect(() => {
    if (!selectedProjectId) { setDocuments([]); return; }
    const q = query(collection(db, 'projects', selectedProjectId, 'documents'), orderBy('createdAt', 'desc'));
    return onSnapshot(q, (snap) => setDocuments(snap.docs.map((d) => ({ id: d.id, projectId: selectedProjectId, ...d.data() }))),
      (err) => console.warn('No se pudieron cargar documentos:', err.message));
  }, [selectedProjectId]);

  useEffect(() => {
    const unsubs = documents.map((d) => onSnapshot(collection(db, 'projects', d.projectId, 'documents', d.id, 'signatures'), (snap) => {
      setSignaturesByDoc((prev) => ({ ...prev, [d.id]: snap.docs.map((x) => ({ id: x.id, ...x.data() })) }));
    }, (err) => console.warn('No se pudieron cargar firmas:', err.message)));
    return () => unsubs.forEach((u) => u());
  }, [documents]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const canManageApp = isAdmin;
  const isSignerOnly = !canManageApp && projects.length === 0;

  if (loading || loadingAdmin) return <main className="shell"><Card>Cargando...</Card></main>;
  if (!user) return <Login />;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>GB Sign</h1>
          <p>Gestión interna de documentos y firma electrónica con acceso externo limitado por mail.</p>
        </div>
        <div className="userbox">
          {user.photoURL && <img src={user.photoURL} alt="" />}
          <span>{user.displayName || user.email}</span>
          <Badge tone={canManageApp ? 'good' : projects.length ? 'neutral' : 'warn'}>{canManageApp ? 'Administrador' : projects.length ? 'Colaborador' : 'Firmante'}</Badge>
          <Button variant="ghost" onClick={() => signOut(auth)}><LogOut size={16}/> Salir</Button>
        </div>
      </header>

      {isSignerOnly && <SignerOnlyNotice user={user} />}

      <section className={`grid ${isSignerOnly ? 'one' : 'two'}`}>
        {!isSignerOnly && (
          <Card>
            <div className="cardHead"><h2>Proyectos internos</h2><FolderPlus size={22}/></div>
            {canManageApp ? <CreateProject onCreated={setSelectedProjectId}/> : <p className="muted">Solo los administradores pueden crear proyectos. Los colaboradores pueden trabajar dentro de los proyectos donde fueron agregados.</p>}
            <div className="list">
              {projects.map((p) => <button key={p.id} className={`row ${p.id === selectedProjectId ? 'active' : ''}`} onClick={() => setSelectedProjectId(p.id)}>
                <strong>{p.name}</strong><span>{p.client || 'Sin cliente'} · {fmtDate(p.createdAt)}</span>
              </button>)}
              {!projects.length && <Empty title="Sin proyectos internos">Cuando seas administrador o colaborador de un proyecto, aparecerá acá.</Empty>}
            </div>
          </Card>
        )}

        <Card>
          <div className="cardHead"><h2>Documentos para firmar</h2><FileSignature size={22}/></div>
          <div className="list">
            {pending.map((d) => <PendingDoc key={d.id} request={d} user={user}/>) }
            {!pending.length && <Empty title="Sin documentos asignados">Cuando pidan una firma con este mail de Google, el documento aparecerá acá.</Empty>}
          </div>
        </Card>
      </section>

      {selectedProject && <ProjectPanel project={selectedProject} documents={documents} signaturesByDoc={signaturesByDoc} user={user} isAdmin={isAdmin}/>} 
    </main>
  );
}

function Login() {
  return <main className="login"><Card className="loginCard"><ShieldCheck size={46}/><h1>GB Sign</h1><p>Ingresá con Google. Si sos firmante, solo vas a ver los documentos asignados exactamente a tu correo.</p><Button onClick={() => signInWithPopup(auth, provider)}>Ingresar con Google</Button></Card></main>;
}

function SignerOnlyNotice({ user }) {
  async function copyUid() {
    await navigator.clipboard?.writeText(user.uid);
  }
  return <Card className="notice">
    <div className="cardHead"><h2>Acceso de firmante</h2><LockKeyhole size={22}/></div>
    <p>Este usuario no tiene permisos internos. Solo puede ver y firmar documentos solicitados para <strong>{normalizeEmail(user.email)}</strong>.</p>
    <small>UID de este usuario, solo para configurar administradores internos si hiciera falta:</small>
    <div className="copyline"><code>{user.uid}</code><Button variant="ghost" onClick={copyUid}><ClipboardCopy size={15}/> Copiar UID</Button></div>
  </Card>;
}

function CreateProject({ onCreated }) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const user = auth.currentUser;
    const refDoc = await addDoc(collection(db, 'projects'), {
      name: name.trim(), client: client.trim(), ownerUid: user.uid, ownerEmail: normalizeEmail(user.email), collaboratorEmails: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    await setDoc(doc(db, 'projects', refDoc.id, 'members', user.uid), { uid: user.uid, email: normalizeEmail(user.email), role: 'owner', createdAt: serverTimestamp() });
    setName(''); setClient(''); onCreated(refDoc.id);
  }
  return <form className="inlineForm" onSubmit={submit}><input placeholder="Nombre del proyecto" value={name} onChange={(e)=>setName(e.target.value)}/><input placeholder="Cliente / marca" value={client} onChange={(e)=>setClient(e.target.value)}/><Button>Crear</Button></form>;
}

function ProjectPanel({ project, documents, signaturesByDoc, user, isAdmin }) {
  const isOwner = project.ownerUid === user.uid;
  const canManageMembers = isAdmin || isOwner;
  const [settingsOpen, setSettingsOpen] = useState(false);

  return <section className="project">
    <div className="sectionTitle projectTitle">
      <div><h2>{project.name}</h2><Badge>{project.client || 'Proyecto interno'}</Badge></div>
      <Button variant="ghost" type="button" onClick={() => setSettingsOpen((v) => !v)}><Settings size={16}/> Configuración</Button>
    </div>

    {settingsOpen && <Card className="settingsCard">
      <div className="cardHead"><h3>Configuración del proyecto</h3><Users size={22}/></div>
      <Members project={project} currentUser={user} canManage={canManageMembers}/>
    </Card>}

    <section className="grid one">
      <Card><div className="cardHead"><h3>Cargar documento y solicitar firmas</h3><Upload size={22}/></div><UploadDocument project={project}/></Card>
    </section>
    <Card><h3>Documentos del proyecto</h3><div className="table">
      <div className="tr th"><span>Documento</span><span>Firmantes externos</span><span>Estado</span><span>Acciones</span></div>
      {documents.map((d) => <DocumentRow key={d.id} project={project} docu={d} signatures={signaturesByDoc[d.id] || []}/>) }
    </div>{!documents.length && <Empty title="Sin documentos">Subí un PDF, imagen o documento para solicitar firmas.</Empty>}</Card>
  </section>;
}

async function createSignatureRequests(project, docu) {
  const signerEmails = docu.signerEmails || [];
  if (!signerEmails.length) return;
  const batch = writeBatch(db);
  signerEmails.forEach((signerEmail) => {
    const normalized = normalizeEmail(signerEmail);
    const requestRef = doc(db, 'signatureRequests', signatureRequestId(project.id, docu.id, normalized));
    const signatureFields = (docu.signatureFields || []).filter((f) => normalizeEmail(f.signerEmail) === normalized);
    batch.set(requestRef, {
      projectId: project.id,
      projectName: project.name || '',
      projectClient: project.client || '',
      docId: docu.id,
      title: docu.title,
      fileName: docu.fileName,
      contentType: docu.contentType || '',
      storagePath: docu.storagePath || '',
      sha256: docu.sha256,
      signerEmail: normalized,
      signatureFields,
      requestedByUid: auth.currentUser.uid,
      requestedByEmail: normalizeEmail(auth.currentUser.email),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  });
  await batch.commit();
}

function UploadDocument({ project }) {
  const [title, setTitle] = useState('');
  const [emails, setEmails] = useState('');
  const [file, setFile] = useState(null);
  const [signatureFields, setSignatureFields] = useState([]);
  const [busy, setBusy] = useState(false);
  const signerEmails = useMemo(() => parseEmails(emails), [emails]);
  const fileUrl = useObjectUrl(file);

  useEffect(() => {
    setSignatureFields((prev) => prev.filter((f) => signerEmails.includes(normalizeEmail(f.signerEmail))));
  }, [signerEmails.join('|')]);

  async function submit(e) {
    e.preventDefault();
    if (!file || !title.trim()) return;
    if (signerEmails.length && signatureFields.length < signerEmails.length) {
      alert('Falta marcar al menos un recuadro de firma para cada firmante externo.');
      return;
    }
    setBusy(true);
    try {
      const hash = await sha256File(file);
      const docRef = await addDoc(collection(db, 'projects', project.id, 'documents'), {
        title: title.trim(), fileName: file.name, contentType: file.type || 'application/octet-stream', size: file.size,
        sha256: hash, signerEmails, signatureFields, uploadedByUid: auth.currentUser.uid, uploadedByEmail: normalizeEmail(auth.currentUser.email),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      const storagePath = `projects/${project.id}/documents/${docRef.id}/${file.name}`;
      await uploadBytes(ref(storage, storagePath), file, { contentType: file.type, customMetadata: { projectId: project.id, docId: docRef.id, sha256: hash } });
      const docPayload = { id: docRef.id, projectId: project.id, title: title.trim(), fileName: file.name, contentType: file.type || 'application/octet-stream', storagePath, sha256: hash, signerEmails, signatureFields };
      await updateDoc(docRef, { storagePath, updatedAt: serverTimestamp() });
      await createSignatureRequests(project, docPayload);
      setTitle(''); setEmails(''); setFile(null); setSignatureFields([]);
    } finally { setBusy(false); }
  }

  return <form className="stack" onSubmit={submit}>
    <Field label="Título"><input value={title} onChange={(e)=>setTitle(e.target.value)} placeholder="Ej: Cesión de imagen - Actor"/></Field>
    <Field label="Mails de Google de firmantes externos" hint="Estos correos solo podrán ver y firmar este documento puntual. No son colaboradores internos."><textarea value={emails} onChange={(e)=>setEmails(e.target.value)} placeholder="persona@gmail.com, otra@empresa.com"/></Field>
    <Field label="Archivo"><input type="file" accept="application/pdf,image/*,.doc,.docx" onChange={(e)=>setFile(e.target.files?.[0] || null)}/></Field>
    {file && signerEmails.length > 0 && <SignatureFieldDesigner fileUrl={fileUrl} fileName={file.name} contentType={file.type} signerEmails={signerEmails} fields={signatureFields} onChange={setSignatureFields}/>} 
    <Button disabled={busy}>{busy ? 'Subiendo...' : 'Cargar y solicitar firmas'}</Button>
  </form>;
}

function Members({ project, currentUser, canManage }) {
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  useEffect(() => onSnapshot(collection(db, 'projects', project.id, 'members'), (snap) => setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('No se pudieron cargar miembros:', err.message)), [project.id]);
  async function addMember(e) {
    e.preventDefault();
    const clean = normalizeEmail(email);
    if (!clean) return;
    const pseudoUid = `email_${emailKey(clean)}`;
    const nextEmails = [...new Set([...(project.collaboratorEmails || []), clean])];
    await updateDoc(doc(db, 'projects', project.id), { collaboratorEmails: nextEmails, updatedAt: serverTimestamp() });
    await setDoc(doc(db, 'projects', project.id, 'members', pseudoUid), { email: clean, role: 'collaborator', createdAt: serverTimestamp(), invitedBy: normalizeEmail(currentUser.email) });
    setEmail('');
  }
  return <div className="stack">
    {canManage ? <form className="inlineForm compact" onSubmit={addMember}><input placeholder="mail del colaborador interno" value={email} onChange={(e)=>setEmail(e.target.value)}/><Button>Agregar</Button></form> : <p className="muted">Solo el dueño del proyecto o un administrador puede agregar colaboradores internos.</p>}
    <div className="chips">{members.map((m)=><span className="chip" key={m.id}>{m.email} · {m.role}</span>)}</div>
    <small>Un colaborador interno puede ver el proyecto, cargar documentos y descargar archivos. Un firmante externo no debe cargarse acá.</small>
  </div>;
}

function DocumentRow({ project, docu, signatures }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState('');
  const [editFields, setEditFields] = useState(false);
  const tone = statusFor(docu, signatures) === 'Completo' ? 'good' : 'warn';
  const isPdf = (docu.contentType || '').includes('pdf') || /\.pdf$/i.test(docu.fileName || '');

  async function openFile() {
    const u = await getDownloadURL(ref(storage, docu.storagePath));
    setUrl(u); window.open(u, '_blank', 'noopener,noreferrer');
  }

  function evidence() {
    const payload = {
      certificateType: 'GB Sign electronic signature evidence',
      generatedAt: new Date().toISOString(),
      generatedBy: normalizeEmail(auth.currentUser?.email || ''),
      project,
      document: docu,
      signatures,
    };
    downloadText(`evidencia-${safeFileName(docu.title)}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }

  async function downloadSignedPdf() {
    if (!isPdf) { alert('La descarga de PDF firmado por ahora está disponible para documentos PDF.'); return; }
    if (!signatures.length) { alert('Todavía no hay firmas para estampar en el PDF.'); return; }
    setPdfBusy('signed');
    try {
      const bytes = await buildSignedPdf({ project, docu, signatures });
      downloadBytes(`${safeFileName(docu.title)}-firmado-gb-sign.pdf`, bytes, 'application/pdf');
    } catch (err) {
      console.error(err);
      alert(`No se pudo generar el PDF firmado: ${err.message || err}`);
    } finally {
      setPdfBusy('');
    }
  }

  async function downloadCertificatePdf() {
    if (!signatures.length) { alert('Todavía no hay firmas para certificar.'); return; }
    setPdfBusy('certificate');
    try {
      const bytes = await buildEvidenceCertificatePdf({ project, docu, signatures });
      downloadBytes(`${safeFileName(docu.title)}-certificado-evidencia-gb-sign.pdf`, bytes, 'application/pdf');
    } catch (err) {
      console.error(err);
      alert(`No se pudo generar el certificado: ${err.message || err}`);
    } finally {
      setPdfBusy('');
    }
  }

  async function syncRequests() {
    setBusy(true);
    try { await createSignatureRequests(project, docu); }
    finally { setBusy(false); }
  }

  return <>
    <div className="tr"><span><strong>{docu.title}</strong><small>{docu.fileName}<br/>SHA-256: {docu.sha256}<br/>Campos de firma: {(docu.signatureFields || []).length}</small></span><span>{(docu.signerEmails || []).map((e)=><small key={e}>{e}</small>)}</span><span><Badge tone={tone}>{statusFor(docu, signatures)}</Badge></span><span className="actions"><Button variant="ghost" onClick={openFile}><Download size={16}/> Ver</Button><Button variant="ghost" onClick={() => setEditFields((v)=>!v)}><PenLine size={16}/> Campos</Button><Button variant="ghost" onClick={syncRequests} disabled={busy}>{busy ? 'Activando...' : 'Activar firmantes'}</Button><Button variant="ghost" onClick={downloadSignedPdf} disabled={pdfBusy === 'signed'}>{pdfBusy === 'signed' ? 'Generando...' : 'PDF firmado'}</Button><Button variant="ghost" onClick={downloadCertificatePdf} disabled={pdfBusy === 'certificate'}>{pdfBusy === 'certificate' ? 'Generando...' : 'Certificado PDF'}</Button><Button variant="ghost" onClick={evidence}>JSON</Button>{url && <a href={url}>link</a>}</span></div>
    {editFields && <EditSignatureFields project={project} docu={docu} onClose={() => setEditFields(false)}/>} 
  </>;
}

function safeFileName(value = 'documento') {
  return String(value || 'documento')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'documento';
}

function signedAtDate(sig) {
  return sig?.signedAt?.toDate ? sig.signedAt.toDate() : sig?.signedAt ? new Date(sig.signedAt) : null;
}

function signedAtText(sig) {
  const d = signedAtDate(sig);
  if (!d || Number.isNaN(d.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'full', timeStyle: 'long', timeZone: 'America/Argentina/Buenos_Aires'
  }).format(d) + ' (Argentina)';
}

function dataUrlToBytes(dataUrl = '') {
  const base64 = String(dataUrl).split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fitImage(image, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  return { width: image.width * scale, height: image.height * scale };
}

async function fetchDocumentBytes(docu) {
  const u = await getDownloadURL(ref(storage, docu.storagePath));
  const response = await fetch(u);
  if (!response.ok) throw new Error(`Storage respondió ${response.status}`);
  return response.arrayBuffer();
}

async function buildSignedPdf({ project, docu, signatures }) {
  const originalBytes = await fetchDocumentBytes(docu);
  const originalHash = await sha256Bytes(originalBytes);
  if (docu.sha256 && originalHash !== docu.sha256) {
    throw new Error('El hash del archivo descargado no coincide con el hash guardado. No se genera el PDF firmado.');
  }

  const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
  const fonts = await loadPdfFonts(pdfDoc);
  pdfDoc.setTitle(`${docu.title} - firmado electrónicamente por GB Sign`);
  pdfDoc.setSubject('PDF con firmas electrónicas visuales y certificado de evidencia generado por GB Sign.');
  pdfDoc.setKeywords(['GB Sign', 'firma electrónica', 'evidencia', docu.sha256 || '']);
  pdfDoc.setProducer('GB Sign');
  pdfDoc.setCreator('GB Sign');
  pdfDoc.setModificationDate(new Date());

  for (const sig of signatures) {
    const field = sig.signatureField || (docu.signatureFields || []).find((f) => f.id === sig.fieldId || normalizeEmail(f.signerEmail) === normalizeEmail(sig.email));
    if (!field) continue;
    const pageIndex = Math.max(0, Math.min(pdfDoc.getPageCount() - 1, Number(field.page || 1) - 1));
    const page = pdfDoc.getPage(pageIndex);
    await drawSignatureStamp(pdfDoc, page, field, sig, fonts);
  }

  await appendEvidencePages(pdfDoc, { project, docu, signatures, originalHash, fonts, includeLegalNote: true });
  return pdfDoc.save();
}

async function buildEvidenceCertificatePdf({ project, docu, signatures }) {
  const pdfDoc = await PDFDocument.create();
  const fonts = await loadPdfFonts(pdfDoc);
  let originalHash = docu.sha256 || '';
  try {
    const originalBytes = await fetchDocumentBytes(docu);
    originalHash = await sha256Bytes(originalBytes);
  } catch (err) {
    console.warn('No se pudo recalcular hash del documento para el certificado:', err.message);
  }
  pdfDoc.setTitle(`${docu.title} - certificado de evidencia GB Sign`);
  pdfDoc.setSubject('Certificado de evidencia de firma electrónica generado por GB Sign.');
  pdfDoc.setKeywords(['GB Sign', 'firma electrónica', 'certificado de evidencia', originalHash || '']);
  pdfDoc.setProducer('GB Sign');
  pdfDoc.setCreator('GB Sign');
  pdfDoc.setCreationDate(new Date());
  await appendEvidencePages(pdfDoc, { project, docu, signatures, originalHash, fonts, includeLegalNote: true });
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
  const x = field.x * width;
  const boxW = Math.max(70, field.w * width);
  const boxH = Math.max(34, field.h * height);
  const y = height - (field.y * height) - boxH;
  const pad = Math.max(3, Math.min(8, boxH * 0.12));
  const metaH = Math.min(28, Math.max(16, boxH * 0.34));

  page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: rgb(0.08, 0.08, 0.08), borderWidth: 0.9, color: rgb(1, 1, 1), opacity: 0.92 });
  page.drawLine({ start: { x: x + pad, y: y + metaH + 1 }, end: { x: x + boxW - pad, y: y + metaH + 1 }, thickness: 0.6, color: rgb(0.1, 0.1, 0.1) });

  const signatureAreaH = Math.max(8, boxH - metaH - pad * 1.5);
  if (sig.signatureType === 'drawn' && sig.signatureImage) {
    try {
      const png = await pdfDoc.embedPng(dataUrlToBytes(sig.signatureImage));
      const dims = fitImage(png, boxW - pad * 2, signatureAreaH);
      page.drawImage(png, { x: x + (boxW - dims.width) / 2, y: y + metaH + 4 + Math.max(0, (signatureAreaH - dims.height) / 2), width: dims.width, height: dims.height });
    } catch (err) {
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

function compactDate(sig) {
  const d = signedAtDate(sig);
  if (!d || Number.isNaN(d.getTime())) return 'fecha no disponible';
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(d);
}

async function appendEvidencePages(pdfDoc, { project, docu, signatures, originalHash, fonts, includeLegalNote = true }) {
  const margin = 42;
  let page = pdfDoc.addPage([595.28, 841.89]);
  let y = 792;

  const newPage = () => {
    page = pdfDoc.addPage([595.28, 841.89]);
    y = 792;
  };

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

  text('Este certificado resume la evidencia técnica asociada al documento y a las firmas electrónicas registradas en GB Sign.', { size: 10, maxChars: 88 });
  y -= 8;

  row('Proyecto', `${project.name || '-'}${project.client ? ` · ${project.client}` : ''}`);
  row('Documento', `${docu.title || '-'} · ${docu.fileName || '-'}`);
  row('ID documento', docu.id || '-');
  row('Hash SHA-256 original', originalHash || docu.sha256 || '-');
  row('Generado por', normalizeEmail(auth.currentUser?.email || '-') || '-');
  row('Fecha generación', new Intl.DateTimeFormat('es-AR', { dateStyle: 'full', timeStyle: 'long', timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date()) + ' (Argentina)');
  row('Cantidad de firmantes', `${signatures.length} firma(s) registradas de ${(docu.signerEmails || []).length} firmante(s) solicitados.`);

  if (includeLegalNote) {
    y -= 8;
    text('Nota legal operativa', { size: 12, bold: true, maxChars: 88 });
    text('GB Sign registra firmas electrónicas con evidencia de autenticación, intención, consentimiento, DNI declarado, hash de integridad del documento y fecha de firma. No reemplaza una firma digital certificada con autoridad certificante, pero busca conservar evidencia suficiente para acreditar autenticidad e integridad si la firma electrónica fuera desconocida.', { size: 9, maxChars: 94 });
  }

  y -= 10;
  text('Detalle de firmas', { size: 14, bold: true, maxChars: 88 });

  for (const [index, sig] of signatures.entries()) {
    ensure(230);
    page.drawRectangle({ x: margin, y: y - 6, width: 511, height: 1, color: rgb(0.88, 0.88, 0.88) });
    y -= 24;
    text(`Firma ${index + 1}: ${sig.displayName || sig.typedName || sig.email || 'Firmante'}`, { size: 12, bold: true, maxChars: 88 });
    row('Email autenticado', sig.email || '-');
    row('UID Firebase', sig.uid || '-');
    row('DNI declarado', sig.dni ? `${sig.dni} (${sig.dniConfirmed ? 'confirmado por el firmante' : 'sin confirmación'})` : '-');
    row('Fecha y hora', signedAtText(sig));
    row('Tipo de firma', sig.signatureType === 'drawn' ? 'Firma dibujada con mouse/touch' : 'Firma cursiva generada con nombre');
    row('Hash firmado', sig.documentSha256 || docu.sha256 || '-');
    row('Campo visual', sig.fieldId || sig.signatureField?.id || '-');
    row('User agent', sig.userAgent || '-');
    row('Acción de intención', sig.intentAction || '-');
    row('Texto aceptado', sig.acceptedText || ACCEPTANCE_TEXT);

    ensure(82);
    page.drawText('Representación visual de la firma:', { x: margin, y, size: 9, font: fonts.bold, color: rgb(0.12, 0.12, 0.12) });
    y -= 68;
    page.drawRectangle({ x: margin, y, width: 220, height: 56, borderColor: rgb(0.18, 0.18, 0.18), borderWidth: 0.8, color: rgb(1, 1, 1), opacity: 0.95 });
    if (sig.signatureType === 'drawn' && sig.signatureImage) {
      try {
        const png = await pdfDoc.embedPng(dataUrlToBytes(sig.signatureImage));
        const dims = fitImage(png, 204, 46);
        page.drawImage(png, { x: margin + 8 + (204 - dims.width) / 2, y: y + 5 + (46 - dims.height) / 2, width: dims.width, height: dims.height });
      } catch (err) {
        page.drawText('Firma dibujada registrada', { x: margin + 10, y: y + 23, size: 12, font: fonts.italic });
      }
    } else {
      page.drawText(sig.typedName || sig.displayName || sig.email || 'Firma', { x: margin + 10, y: y + 22, size: 21, font: fonts.italic, color: rgb(0.04, 0.04, 0.04), maxWidth: 200 });
    }
    y -= 22;
  }
}

function wrapText(value, maxChars = 90) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}


function EditSignatureFields({ project, docu, onClose }) {
  const [fields, setFields] = useState(docu.signatureFields || []);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getDownloadURL(ref(storage, docu.storagePath)).then(setUrl).catch((err) => console.warn('No se pudo abrir el documento:', err.message));
  }, [docu.storagePath]);
  async function save() {
    setBusy(true);
    try {
      await updateDoc(doc(db, 'projects', project.id, 'documents', docu.id), { signatureFields: fields, updatedAt: serverTimestamp() });
      await createSignatureRequests(project, { ...docu, signatureFields: fields });
      onClose();
    } finally { setBusy(false); }
  }
  return <div className="editorRow"><Card>
    <div className="cardHead"><h3>Campos de firma: {docu.title}</h3><Button variant="ghost" onClick={onClose}>Cerrar</Button></div>
    {url ? <SignatureFieldDesigner fileUrl={url} fileName={docu.fileName} contentType={docu.contentType} signerEmails={docu.signerEmails || []} fields={fields} onChange={setFields}/> : <p>Cargando vista previa...</p>}
    <div className="actions"><Button onClick={save} disabled={busy}>{busy ? 'Guardando...' : 'Guardar campos'}</Button></div>
  </Card></div>;
}

function PendingDoc({ request, user }) {
  const [signed, setSigned] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => onSnapshot(doc(db, 'projects', request.projectId, 'documents', request.docId, 'signatures', user.uid), (snap) => setSigned(snap.exists()),
    (err) => console.warn('No se pudo cargar estado de firma:', err.message)), [request.projectId, request.docId, user.uid]);
  return <div className="pendingBlock"><div className="pending"><div><strong>{request.title}</strong><small>{request.projectName || 'Proyecto'} · {request.fileName}<br/>Hash: {request.sha256}</small></div><div className="actions">{signed ? <Badge tone="good"><CheckCircle2 size={14}/> Firmado</Badge> : <Button onClick={() => setOpen((v)=>!v)}>{open ? 'Cerrar' : 'Abrir para firmar'}</Button>}</div></div>{open && !signed && <SigningRoom request={request} user={user}/>}</div>;
}


function SigningRoom({ request, user }) {
  const [url, setUrl] = useState('');
  const [activeFieldId, setActiveFieldId] = useState('');
  const [signatureMode, setSignatureMode] = useState('drawn');
  const [typedName, setTypedName] = useState(user.displayName || '');
  const [signatureImage, setSignatureImage] = useState('');
  const [dni, setDni] = useState('');
  const [dniConfirmed, setDniConfirmed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const fields = (request.signatureFields || []).filter((f) => normalizeEmail(f.signerEmail) === normalizeEmail(user.email));
  const activeField = fields.find((f) => f.id === activeFieldId) || fields[0] || null;
  const cleanDni = normalizeDni(dni);

  useEffect(() => {
    getDownloadURL(ref(storage, request.storagePath)).then(setUrl).catch((err) => console.warn('No se pudo abrir el documento:', err.message));
  }, [request.storagePath]);

  useEffect(() => {
    if (!activeFieldId && fields[0]) setActiveFieldId(fields[0].id);
  }, [fields, activeFieldId]);

  async function sign() {
    if (!activeField) { alert('No hay campo de firma asignado para tu mail.'); return; }
    if (!cleanDni || cleanDni.length < 6) { alert('Completá tu DNI con números.'); return; }
    if (!dniConfirmed) { alert('Tenés que confirmar que el DNI ingresado es correcto.'); return; }
    if (!consent) { alert('Tenés que aceptar el consentimiento de firma electrónica.'); return; }
    if (signatureMode === 'drawn' && !signatureImage) { alert('Dibujá tu firma o elegí la firma cursiva por nombre.'); return; }
    if (signatureMode === 'typed' && !typedName.trim()) { alert('Completá tu nombre para la firma cursiva.'); return; }
    setBusy(true);
    try {
      const renderedSignature = signatureMode === 'typed' ? typedName.trim() : signatureImage;
      await setDoc(doc(db, 'projects', request.projectId, 'documents', request.docId, 'signatures', user.uid), {
        uid: user.uid,
        email: normalizeEmail(user.email),
        displayName: user.displayName || '',
        dni: cleanDni,
        dniEntered: dni.trim(),
        dniConfirmed: true,
        identityStatement: `El firmante declaró y confirmó DNI ${cleanDni} al momento de firmar.`,
        documentSha256: request.sha256,
        fieldId: activeField.id,
        signatureField: activeField,
        signatureType: signatureMode,
        signatureImage: signatureMode === 'drawn' ? signatureImage : '',
        typedName: signatureMode === 'typed' ? typedName.trim() : '',
        renderedSignature,
        consentElectronicSignature: true,
        intentAction: 'El firmante abrió el documento, presionó su campo de firma asignado, declaró su DNI y confirmó la firma electrónica.',
        acceptedText: ACCEPTANCE_TEXT,
        userAgent: navigator.userAgent,
        screen: { width: window.screen?.width || null, height: window.screen?.height || null, pixelRatio: window.devicePixelRatio || 1 },
        signedAt: serverTimestamp(),
      });
    } finally { setBusy(false); }
  }

  return <Card className="signingRoom">
    <div className="cardHead"><h3>Revisar y firmar</h3><Badge tone="warn">Firma electrónica</Badge></div>
    <p className="muted">Presioná tu recuadro asignado dentro del documento. Luego completá tu DNI, dibujá tu firma o usá una firma cursiva generada con tu nombre.</p>
    {url ? <DocumentPreview url={url} fileName={request.fileName} contentType={request.contentType} fields={fields} activeFieldId={activeFieldId} onSelectField={setActiveFieldId} signatures={buildPreviewSignatures(activeField, signatureMode, signatureImage, typedName)}/> : <p>Cargando documento...</p>}
    <div className="grid two signControls">
      <Card>
        <h3>Campo asignado</h3>
        {fields.length ? <div className="chips">{fields.map((f, idx) => <button type="button" className={`chip chipButton ${f.id === activeFieldId ? 'active' : ''}`} key={f.id} onClick={() => setActiveFieldId(f.id)}>Campo {idx + 1} · {f.label || 'Firma'}</button>)}</div> : <p className="muted">No hay un recuadro asignado a tu mail. Pedile al administrador que configure el campo de firma.</p>}
      </Card>
      <Card>
        <h3>Identidad del firmante</h3>
        <Field label="DNI"><input inputMode="numeric" value={dni} onChange={(e)=>setDni(e.target.value)} placeholder="Ej: 34553626"/></Field>
        <label className="check compactCheck"><input type="checkbox" checked={dniConfirmed} onChange={(e)=>setDniConfirmed(e.target.checked)}/><span>Confirmo que este DNI es correcto y me identifica como firmante.</span></label>
      </Card>
      <Card className="wideCard">
        <h3>Tu firma</h3>
        <div className="modeTabs"><button type="button" className={signatureMode === 'drawn' ? 'active' : ''} onClick={() => setSignatureMode('drawn')}>Dibujar</button><button type="button" className={signatureMode === 'typed' ? 'active' : ''} onClick={() => setSignatureMode('typed')}>Nombre cursiva</button></div>
        {signatureMode === 'drawn' ? <SignaturePad onChange={setSignatureImage}/> : <Field label="Nombre a firmar"><input value={typedName} onChange={(e)=>setTypedName(e.target.value)} placeholder="Tu nombre completo"/></Field>}
      </Card>
    </div>
    <label className="check"><input type="checkbox" checked={consent} onChange={(e)=>setConsent(e.target.checked)}/><span>{ACCEPTANCE_TEXT}</span></label>
    <div className="actions"><Button onClick={sign} disabled={busy || !activeField}>{busy ? 'Firmando...' : 'Confirmar firma electrónica'}</Button></div>
  </Card>;
}

function buildPreviewSignatures(activeField, signatureMode, signatureImage, typedName) {
  if (!activeField) return [];
  if (signatureMode === 'drawn' && signatureImage) return [{ field: activeField, image: signatureImage, type: 'drawn' }];
  if (signatureMode === 'typed' && typedName.trim()) return [{ field: activeField, typedName: typedName.trim(), type: 'typed' }];
  return [];
}

function SignatureFieldDesigner({ fileUrl, fileName, contentType, signerEmails, fields, onChange }) {
  const [activeEmail, setActiveEmail] = useState(signerEmails[0] || '');
  const [placing, setPlacing] = useState(false);
  const [draft, setDraft] = useState(null);
  const drawingRef = useRef(null);

  useEffect(() => {
    if (!signerEmails.includes(activeEmail)) setActiveEmail(signerEmails[0] || '');
  }, [signerEmails, activeEmail]);

  function point(target, ev) {
    const rect = target.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
    return { x, y };
  }

  function start(pageNumber, ev) {
    if (!placing || !activeEmail) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    const p = point(ev.currentTarget, ev);
    const next = { page: pageNumber, sx: p.x, sy: p.y, x: p.x, y: p.y, w: 0, h: 0 };
    drawingRef.current = next;
    setDraft(next);
  }

  function move(pageNumber, ev) {
    if (!drawingRef.current || drawingRef.current.page !== pageNumber) return;
    ev.preventDefault();
    const p = point(ev.currentTarget, ev);
    const base = drawingRef.current;
    const next = {
      ...base,
      x: Math.min(base.sx, p.x),
      y: Math.min(base.sy, p.y),
      w: Math.abs(p.x - base.sx),
      h: Math.abs(p.y - base.sy),
    };
    drawingRef.current = next;
    setDraft(next);
  }

  function end(ev) {
    if (!drawingRef.current) return;
    ev?.preventDefault?.();
    const finalDraft = draft || drawingRef.current;
    drawingRef.current = null;
    setDraft(null);
    setPlacing(false);
    if (!finalDraft || finalDraft.w < 0.025 || finalDraft.h < 0.018) return;
    const clean = normalizeEmail(activeEmail);
    const nextField = {
      id: `field_${emailKey(clean)}`,
      signerEmail: clean,
      label: `Firma de ${clean}`,
      page: Number(finalDraft.page) || 1,
      x: round(finalDraft.x), y: round(finalDraft.y), w: round(finalDraft.w), h: round(finalDraft.h),
      createdAtClient: new Date().toISOString(),
    };
    onChange([...(fields || []).filter((f) => normalizeEmail(f.signerEmail) !== clean), nextField]);
  }

  function remove(email) {
    const clean = normalizeEmail(email);
    onChange((fields || []).filter((f) => normalizeEmail(f.signerEmail) !== clean));
  }

  return <div className="signatureDesigner">
    <div className="designerToolbar noPageToolbar">
      <Field label="Firmante"><select value={activeEmail} onChange={(e)=>setActiveEmail(e.target.value)}>{signerEmails.map((e)=><option value={e} key={e}>{e}</option>)}</select></Field>
      <div className="designerModeBox">
        <Button type="button" variant={placing ? 'primary' : 'ghost'} onClick={() => setPlacing((v) => !v)}><PenLine size={16}/>{placing ? 'Modo colocar activo' : 'Colocar recuadro'}</Button>
        {placing && <Button type="button" variant="ghost" onClick={() => { setPlacing(false); setDraft(null); drawingRef.current = null; }}>Volver a navegar</Button>}
      </div>
      <div className="designerHint"><strong>Cómo marcar el campo:</strong><br/>Primero navegá y scrolleá el documento. Cuando estés en el lugar correcto, tocá <strong>Colocar recuadro</strong> y arrastrá sobre la firma. Al soltar, vuelve al modo navegación.</div>
    </div>
    <DocumentSurface
      url={fileUrl}
      fileName={fileName}
      contentType={contentType}
      fields={fields || []}
      activeFieldId={`field_${emailKey(activeEmail)}`}
      designer
      placing={placing}
      draft={draft}
      onPagePointerDown={start}
      onPagePointerMove={move}
      onPagePointerUp={end}
      onPagePointerCancel={end}
    />
    <div className="fieldStatus">
      {signerEmails.map((email) => {
        const field = (fields || []).find((f) => normalizeEmail(f.signerEmail) === normalizeEmail(email));
        return <div className="fieldStatusItem" key={email}><span>{email}</span>{field ? <Badge tone="good">Campo marcado</Badge> : <Badge tone="warn">Falta campo</Badge>}{field && <Button variant="ghost" type="button" onClick={() => remove(email)}>Borrar</Button>}</div>;
      })}
    </div>
  </div>;
}

function DocumentPreview({ url, fileName, contentType, fields, activeFieldId, onSelectField, signatures = [] }) {
  return <DocumentSurface url={url} fileName={fileName} contentType={contentType} fields={fields || []} activeFieldId={activeFieldId} onSelectField={onSelectField} signatures={signatures}/>;
}

function DocumentSurface({ url, fileName, contentType, fields = [], activeFieldId, onSelectField, signatures = [], designer = false, placing = false, draft, onPagePointerDown, onPagePointerMove, onPagePointerUp, onPagePointerCancel }) {
  const isImage = (contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(fileName || '');
  const isPdf = (contentType || '').includes('pdf') || /\.pdf$/i.test(fileName || '');
  const className = `docPreview ${designer ? 'designer' : 'readonly'} ${placing ? 'placing' : 'navigating'}`;
  if (isPdf) return <PdfDocumentSurface className={className} url={url} fileName={fileName} fields={fields} activeFieldId={activeFieldId} onSelectField={onSelectField} signatures={signatures} designer={designer} placing={placing} draft={draft} onPagePointerDown={onPagePointerDown} onPagePointerMove={onPagePointerMove} onPagePointerUp={onPagePointerUp} onPagePointerCancel={onPagePointerCancel}/>;
  if (isImage) return <ImageDocumentSurface className={className} url={url} fileName={fileName} fields={fields} activeFieldId={activeFieldId} onSelectField={onSelectField} signatures={signatures} designer={designer} placing={placing} draft={draft} onPagePointerDown={onPagePointerDown} onPagePointerMove={onPagePointerMove} onPagePointerUp={onPagePointerUp} onPagePointerCancel={onPagePointerCancel}/>;
  return <div className={className}><div className="previewFallback"><strong>{fileName}</strong><p>La vista previa completa depende del navegador. Para marcar campos visuales con precisión conviene subir PDF o imagen.</p></div></div>;
}

function ImageDocumentSurface({ className, url, fileName, fields, activeFieldId, onSelectField, signatures, designer, placing, draft, onPagePointerDown, onPagePointerMove, onPagePointerUp, onPagePointerCancel }) {
  return <div className={className}>
    <div className="imagePage docPage">
      <img className="previewFile" src={url} alt={fileName || 'Documento'} draggable="false"/>
      <SignaturePageOverlay pageNumber={1} fields={fields} activeFieldId={activeFieldId} onSelectField={onSelectField} signatures={signatures} designer={designer} placing={placing} draft={draft} onPagePointerDown={onPagePointerDown} onPagePointerMove={onPagePointerMove} onPagePointerUp={onPagePointerUp} onPagePointerCancel={onPagePointerCancel}/>
    </div>
  </div>;
}

const PDFJS_CDN_VERSION = '4.10.38';
let pdfJsPromise = null;
async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import(/* @vite-ignore */ `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_CDN_VERSION}/build/pdf.mjs`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_CDN_VERSION}/build/pdf.worker.mjs`;
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

function PdfDocumentSurface({ className, url, fileName, fields, activeFieldId, onSelectField, signatures, designer, placing, draft, onPagePointerDown, onPagePointerMove, onPagePointerUp, onPagePointerCancel }) {
  const [pdf, setPdf] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let task = null;
    setPdf(null); setPageCount(0); setError('');
    loadPdfJs().then((pdfjs) => {
      if (cancelled) return;
      task = pdfjs.getDocument({ url });
      return task.promise;
    }).then((loadedPdf) => {
      if (!loadedPdf || cancelled) return;
      setPdf(loadedPdf);
      setPageCount(loadedPdf.numPages || 0);
    }).catch((err) => {
      if (!cancelled) setError(err?.message || 'No se pudo cargar la vista previa PDF.');
    });
    return () => { cancelled = true; task?.destroy?.(); };
  }, [url]);

  if (error) return <div className={className}><div className="previewFallback"><strong>{fileName}</strong><p>{error}</p><p>Podés abrir el documento original para revisarlo, pero para marcar campos visuales hace falta que cargue la vista previa PDF.</p></div></div>;
  if (!pdf) return <div className={className}><div className="previewFallback"><strong>{fileName}</strong><p>Cargando vista previa del PDF...</p></div></div>;

  return <div className={className}>
    <div className="pdfPageList">
      {Array.from({ length: pageCount }, (_, i) => {
        const pageNumber = i + 1;
        return <PdfPageCanvas key={pageNumber} pdf={pdf} pageNumber={pageNumber}>
          <SignaturePageOverlay pageNumber={pageNumber} fields={fields} activeFieldId={activeFieldId} onSelectField={onSelectField} signatures={signatures} designer={designer} placing={placing} draft={draft} onPagePointerDown={onPagePointerDown} onPagePointerMove={onPagePointerMove} onPagePointerUp={onPagePointerUp} onPagePointerCancel={onPagePointerCancel}/>
        </PdfPageCanvas>;
      })}
    </div>
  </div>;
}

function PdfPageCanvas({ pdf, pageNumber, children }) {
  const canvasRef = useRef(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;
    setRendering(true);
    pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const baseViewport = page.getViewport({ scale: 1.35 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(baseViewport.width * dpr);
      canvas.height = Math.floor(baseViewport.height * dpr);
      canvas.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderTask = page.render({ canvasContext: ctx, viewport: baseViewport });
      return renderTask.promise;
    }).then(() => { if (!cancelled) setRendering(false); }).catch((err) => {
      if (!cancelled) console.warn('No se pudo renderizar página PDF:', err.message);
    });
    return () => { cancelled = true; renderTask?.cancel?.(); };
  }, [pdf, pageNumber]);

  return <div className="pdfPage docPage">
    <div className="pageLabel">Página {pageNumber}</div>
    <canvas ref={canvasRef} className={`pdfCanvas ${rendering ? 'loading' : ''}`}/>
    {children}
  </div>;
}

function SignaturePageOverlay({ pageNumber, fields, activeFieldId, onSelectField, draft, signatures = [], designer = false, placing = false, onPagePointerDown, onPagePointerMove, onPagePointerUp, onPagePointerCancel }) {
  const pageFields = (fields || []).filter((f) => Number(f.page || 1) === Number(pageNumber));
  const pageDraft = draft && Number(draft.page || 1) === Number(pageNumber) ? draft : null;
  const pageSignatures = (signatures || []).filter((sig) => Number(sig.field?.page || 1) === Number(pageNumber));
  return <div
    className={`signatureOverlay ${designer ? 'designerOverlay' : ''} ${placing ? 'placingOverlay' : 'navigateOverlay'}`}
    onPointerDown={(ev) => onPagePointerDown?.(pageNumber, ev)}
    onPointerMove={(ev) => onPagePointerMove?.(pageNumber, ev)}
    onPointerUp={onPagePointerUp}
    onPointerCancel={onPagePointerCancel}
    onPointerLeave={onPagePointerUp}
  >
    {pageFields.map((f) => designer
      ? <div key={f.id} className={`signatureRect ${f.id === activeFieldId ? 'active' : ''}`} style={rectStyle(f)}><span>{f.label || f.signerEmail}</span></div>
      : <button type="button" key={f.id} className={`signatureRect ${f.id === activeFieldId ? 'active' : ''}`} style={rectStyle(f)} onClick={(e) => { e.preventDefault(); onSelectField?.(f.id); }}>
        <span>{f.label || f.signerEmail}</span>
      </button>
    )}
    {pageSignatures.map((sig) => <div key={sig.field.id} className="signatureVisual" style={rectStyle(sig.field)}>{sig.type === 'drawn' ? <img src={sig.image} alt="Firma"/> : <span>{sig.typedName}</span>}</div>)}
    {pageDraft && <div className="signatureRect draft" style={rectStyle(pageDraft)}><span>Nuevo campo</span></div>}
  </div>;
}

function rectStyle(f) {
  return { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function normalizeDni(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 12);
}

function SignaturePad({ onChange }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#141414';
  }, []);

  function pos(ev) {
    const point = ev.touches?.[0] || ev;
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  }

  function begin(ev) {
    ev.preventDefault();
    drawingRef.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const p = pos(ev);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(ev) {
    if (!drawingRef.current) return;
    ev.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pos(ev);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setEmpty(false);
    onChange(canvasRef.current.toDataURL('image/png'));
  }

  function end() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (!empty) onChange(canvasRef.current.toDataURL('image/png'));
  }

  function clear() {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, rect.width, rect.height);
    setEmpty(true);
    onChange('');
  }

  return <div className="padWrap"><canvas ref={canvasRef} className="signaturePad" onMouseDown={begin} onMouseMove={move} onMouseUp={end} onMouseLeave={end} onTouchStart={begin} onTouchMove={move} onTouchEnd={end}/><Button variant="ghost" type="button" onClick={clear}>Limpiar firma</Button></div>;
}

function useObjectUrl(file) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) { setUrl(''); return; }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

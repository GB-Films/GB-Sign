import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  addDoc, collection, doc, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  CheckCircle2, ClipboardCopy, Download, ExternalLink, FileSignature, FolderPlus,
  LockKeyhole, LogOut, Mail, PenLine, QrCode, Settings, ShieldCheck, Smartphone, Trash2, Upload, Users
} from 'lucide-react';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { auth, db, provider, storage, functions } from './firebase';
import { Badge, Button, Card, Empty, Field } from './components.jsx';
import {
  downloadBytes, downloadText, emailKey, fmtDate, normalizeEmail, parseEmails,
  sha256Bytes, sha256File, signatureRequestId, statusFor
} from './utils.js';

const MIN_SIGNATURE_FIELD_W = 0.30;
const MIN_SIGNATURE_FIELD_H = 0.085;

const ACCEPTANCE_TEXT = 'Declaro que revisé el documento indicado, acepto firmarlo electrónicamente, y entiendo que esta acción registra mi identidad autenticada por Google, fecha, evidencia técnica y vinculación al hash del documento.';

function getRouteParams() {
  const search = new URLSearchParams(window.location.search);
  let sign = search.get('sign') || '';
  let mobileSign = search.get('mobileSign') || '';
  const rawHash = (window.location.hash || '').replace(/^#\/?/, '');
  if (rawHash) {
    const hashQueryIndex = rawHash.indexOf('?');
    const hashPath = hashQueryIndex >= 0 ? rawHash.slice(0, hashQueryIndex) : rawHash;
    const hashQuery = hashQueryIndex >= 0 ? rawHash.slice(hashQueryIndex + 1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    sign = sign || hashParams.get('sign') || '';
    mobileSign = mobileSign || hashParams.get('mobileSign') || '';
    const parts = hashPath.split('/').filter(Boolean);
    if (!sign && parts[0] === 'sign' && parts[1]) sign = decodeURIComponent(parts[1]);
    if (!mobileSign && (parts[0] === 'mobileSign' || parts[0] === 'mobile-sign') && parts[1]) mobileSign = decodeURIComponent(parts[1]);
  }
  return { sign, mobileSign };
}

function publicAppUrl() {
  const configured = import.meta.env.VITE_PUBLIC_APP_URL || '';
  const fallback = new URL(import.meta.env.BASE_URL || '/', window.location.origin).toString();
  const raw = configured || fallback;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function buildAppHashLink(kind, requestId) {
  const url = new URL(publicAppUrl());
  url.hash = `/${kind}/${encodeURIComponent(requestId)}`;
  return url.toString();
}

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
  const [directRequestId, setDirectRequestId] = useState(() => getRouteParams().sign);
  const [mobileRequestId, setMobileRequestId] = useState(() => getRouteParams().mobileSign);

  useEffect(() => {
    const onPop = () => {
      const params = getRouteParams();
      setDirectRequestId(params.sign);
      setMobileRequestId(params.mobileSign);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);

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
  if (mobileRequestId) return <MobileSignRoute requestId={mobileRequestId} pending={pending} user={user} />;

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
            {directRequestId && pending.length > 0 && !pending.some((d) => d.id === directRequestId) && <div className="directLinkWarning"><strong>Link de firma detectado.</strong><span>No encontramos ese documento para este mail. Verificá que hayas ingresado con el Google exacto que fue invitado a firmar.</span></div>}
            {pending.map((d) => <PendingDoc key={d.id} request={d} user={user} directOpen={directRequestId === d.id}/>) }
            {!pending.length && <Empty title="Sin documentos asignados">Cuando pidan una firma con este mail de Google, el documento aparecerá acá.</Empty>}
          </div>
        </Card>
      </section>

      {selectedProject && <ProjectPanel project={selectedProject} documents={documents} signaturesByDoc={signaturesByDoc} user={user} isAdmin={isAdmin} onProjectDeleted={() => setSelectedProjectId('')}/>} 
    </main>
  );
}

function Login() {
  const { sign: directRequestId, mobileSign: mobileRequestId } = getRouteParams();
  return <main className="login"><Card className="loginCard"><ShieldCheck size={46}/><h1>GB Sign</h1><p>Ingresá con Google. Si sos firmante, solo vas a ver los documentos asignados exactamente a tu correo.</p>{(directRequestId || mobileRequestId) && <div className="directLoginNotice"><strong>{mobileRequestId ? 'Firma desde celular detectada.' : 'Link directo de firma detectado.'}</strong><span>Después de iniciar sesión vas a ir directo al documento si este Google es el mail invitado.</span></div>}<Button onClick={() => signInWithPopup(auth, provider)}>Ingresar con Google</Button></Card></main>;
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

function ProjectPanel({ project, documents, signaturesByDoc, user, isAdmin, onProjectDeleted }) {
  const isOwner = project.ownerUid === user.uid;
  const canManageMembers = isAdmin || isOwner;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  async function deleteProject() {
    if (!isAdmin) return;
    const ok = window.confirm(`¿Borrar el proyecto "${project.name}"? Se eliminarán documentos, solicitudes, firmas y archivos asociados. Esta acción no se puede deshacer.`);
    if (!ok) return;
    setDeletingProject(true);
    try {
      const fn = httpsCallable(functions, 'deleteProject');
      await fn({ projectId: project.id });
      onProjectDeleted?.();
    } catch (err) {
      console.error(err);
      alert(err?.message || 'No se pudo borrar el proyecto.');
    } finally {
      setDeletingProject(false);
    }
  }

  return <section className="project">
    <div className="sectionTitle projectTitle">
      <div><h2>{project.name}</h2><Badge>{project.client || 'Proyecto interno'}</Badge></div>
      <div className="actions"><Button variant="ghost" type="button" onClick={() => setSettingsOpen((v) => !v)}><Settings size={16}/> Configuración</Button>{isAdmin && <Button variant="danger" type="button" onClick={deleteProject} disabled={deletingProject}><Trash2 size={16}/>{deletingProject ? 'Borrando...' : 'Borrar proyecto'}</Button>}</div>
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
      {documents.map((d) => <DocumentRow key={d.id} project={project} docu={d} signatures={signaturesByDoc[d.id] || []} isAdmin={isAdmin}/>) }
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
      allSignerEmails: signerEmails.map(normalizeEmail),
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
      const initialSignatureStatus = signerEmails.map((email) => ({
        email: normalizeEmail(email),
        status: 'pending',
        displayName: '',
        signedAtIso: '',
      }));
      const docRef = await addDoc(collection(db, 'projects', project.id, 'documents'), {
        title: title.trim(), fileName: file.name, contentType: file.type || 'application/octet-stream', size: file.size,
        sha256: hash, signerEmails, signatureFields, signatureStatus: initialSignatureStatus, uploadedByUid: auth.currentUser.uid, uploadedByEmail: normalizeEmail(auth.currentUser.email),
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

function DocumentRow({ project, docu, signatures, isAdmin }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState('');
  const [editFields, setEditFields] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deletingDoc, setDeletingDoc] = useState(false);
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
      const path = await ensureServerArtifact('signed');
      await downloadStoragePath(path, `${safeFileName(docu.title)}-firmado-gb-sign.pdf`);
    } catch (err) {
      console.error(err);
      alert(`No se pudo descargar/generar el PDF firmado: ${err.message || err}`);
    } finally {
      setPdfBusy('');
    }
  }


  async function downloadCertificatePdf() {
    if (!signatures.length) { alert('Todavía no hay firmas para certificar.'); return; }
    setPdfBusy('certificate');
    try {
      const path = await ensureServerArtifact('certificate');
      await downloadStoragePath(path, `${safeFileName(docu.title)}-certificado-evidencia-gb-sign.pdf`);
    } catch (err) {
      console.error(err);
      alert(`No se pudo descargar/generar el certificado: ${err.message || err}`);
    } finally {
      setPdfBusy('');
    }
  }

  async function deleteDocument() {
    if (!isAdmin) return;
    const ok = window.confirm(`¿Borrar el documento "${docu.title}"? Se eliminarán archivo original, firmas, solicitudes y artefactos asociados. Esta acción no se puede deshacer.`);
    if (!ok) return;
    setDeletingDoc(true);
    try {
      const fn = httpsCallable(functions, 'deleteDocument');
      await fn({ projectId: project.id, docId: docu.id });
    } catch (err) {
      console.error(err);
      alert(err?.message || 'No se pudo borrar el documento.');
    } finally {
      setDeletingDoc(false);
    }
  }


  async function ensureServerArtifact(type) {
    // Siempre regeneramos artefactos para usar el último motor de estampado del servidor.
    const generateArtifacts = httpsCallable(functions, 'generateDocumentArtifacts');
    const result = await generateArtifacts({ projectId: project.id, docId: docu.id });
    const data = result.data || {};
    const path = type === 'signed' ? data.signedPdfPath : data.certificatePdfPath;
    if (!path) throw new Error('La función no devolvió la ruta del archivo generado.');
    return path;
  }

  async function downloadStoragePath(path, filename) {
    const u = await getDownloadURL(ref(storage, path));
    const response = await fetch(u);
    if (!response.ok) throw new Error(`Storage respondió ${response.status}`);
    const blob = await response.blob();
    downloadBytes(filename, blob, blob.type || 'application/pdf');
  }


  async function syncRequests() {
    setBusy(true);
    try { await createSignatureRequests(project, docu); }
    finally { setBusy(false); }
  }

  return <>
    <div className="tr"><span><strong>{docu.title}</strong><small>{docu.fileName}<br/>SHA-256: {docu.sha256}<br/>Campos de firma: {(docu.signatureFields || []).length}</small></span><span>{(docu.signerEmails || []).map((e)=><small key={e}>{e}</small>)}</span><span><Badge tone={tone}>{statusFor(docu, signatures)}</Badge></span><span className="actions adminActions">
      <IconAction label="Ver original" onClick={openFile}><ExternalLink size={16}/></IconAction>
      <IconAction label="Links y QR" onClick={() => setShareOpen((v)=>!v)} active={shareOpen}><QrCode size={16}/></IconAction>
      <IconAction label="Campos de firma" onClick={() => setEditFields((v)=>!v)} active={editFields}><PenLine size={16}/></IconAction>
      <IconAction label={pdfBusy === 'signed' ? 'Generando PDF firmado...' : 'Descargar PDF firmado'} onClick={downloadSignedPdf} disabled={pdfBusy === 'signed'}><FileSignature size={16}/></IconAction>
      <IconAction label={pdfBusy === 'certificate' ? 'Generando certificado...' : 'Descargar certificado de evidencia'} onClick={downloadCertificatePdf} disabled={pdfBusy === 'certificate'}><ShieldCheck size={16}/></IconAction>
      <IconAction label="Descargar evidencia técnica JSON" onClick={evidence}><ClipboardCopy size={16}/></IconAction>
      {isAdmin && <IconAction danger label={deletingDoc ? 'Borrando documento...' : 'Borrar documento'} onClick={deleteDocument} disabled={deletingDoc}><Trash2 size={16}/></IconAction>}
    </span></div>
    {shareOpen && <SignatureSharePanel project={project} docu={docu}/>}
    {editFields && <EditSignatureFields project={project} docu={docu} onClose={() => setEditFields(false)}/>} 
  </>;
}

function IconAction({ label, children, onClick, disabled = false, active = false, danger = false }) {
  return <button type="button" className={`iconAction ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
    {children}
    <span className="srOnly">{label}</span>
  </button>;
}

function SignatureSharePanel({ project, docu }) {
  const signerEmails = [...new Set((docu.signerEmails || []).map(normalizeEmail).filter(Boolean))];
  if (!signerEmails.length) return <div className="editorRow"><Card><p className="muted">Este documento no tiene firmantes externos asignados.</p></Card></div>;
  return <div className="editorRow"><Card className="sharePanel">
    <div className="cardHead"><h3>Compartir link directo de firma</h3><QrCode size={22}/></div>
    <p className="muted">Cada link es específico para un mail. El firmante entra, inicia sesión con ese Google y va directo al documento. El QR permite firmar desde celular con el dedo.</p>
    <div className="shareGrid">
      {signerEmails.map((email) => <SignatureShareRow key={email} project={project} docu={docu} email={email}/>) }
    </div>
  </Card></div>;
}

function SignatureShareRow({ project, docu, email }) {
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const requestId = signatureRequestId(project.id, docu.id, email);
  const link = signingLink(requestId);
  const subject = `Firma solicitada: ${docu.title || docu.fileName || 'documento'}`;
  const body = `Hola,\n\nTe comparto el link directo para revisar y firmar el documento \"${docu.title || docu.fileName || 'documento'}\" en GB Sign.\n\nTenés que ingresar con este mail de Google: ${email}\n\nLink de firma:\n${link}\n\nGracias.`;
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(link, { margin: 1, width: 180, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch((err) => console.warn('No se pudo generar QR:', err.message));
    return () => { cancelled = true; };
  }, [link]);

  async function copyLink() {
    await navigator.clipboard?.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  async function downloadQr() {
    if (!qrDataUrl) return;
    const res = await fetch(qrDataUrl);
    const blob = await res.blob();
    downloadBytes(`qr-firma-${safeFileName(docu.title)}-${emailKey(email)}.png`, blob, 'image/png');
  }

  return <div className="shareRow">
    <div className="shareInfo">
      <strong>{email}</strong>
      <input value={link} readOnly onFocus={(e) => e.currentTarget.select()}/>
      <div className="actions">
        <Button type="button" variant="ghost" onClick={copyLink}><ClipboardCopy size={16}/>{copied ? 'Copiado' : 'Copiar link'}</Button>
        <a className="btn ghost" href={mailto}><Mail size={16}/> Armar email</a>
        <a className="btn ghost" href={link} target="_blank" rel="noreferrer"><ExternalLink size={16}/> Abrir</a>
      </div>
    </div>
    <div className="qrBox">
      {qrDataUrl ? <img src={qrDataUrl} alt={`QR de firma para ${email}`}/> : <span>Generando QR...</span>}
      <Button type="button" variant="ghost" onClick={downloadQr} disabled={!qrDataUrl}><Download size={16}/> Descargar QR</Button>
    </div>
  </div>;
}

function signingLink(requestId) {
  return buildAppHashLink('sign', requestId);
}

function mobileSigningLink(requestId) {
  return buildAppHashLink('mobile-sign', requestId);
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

function isPdfDocument(docu = {}) {
  return (docu.contentType || '').includes('pdf') || /\.pdf$/i.test(docu.fileName || '');
}

function signatureStatusRows(docu = {}, currentEmail = '') {
  const current = normalizeEmail(currentEmail);
  const known = new Map();
  (docu.signatureStatus || []).forEach((item) => {
    const email = normalizeEmail(item.email || item.signerEmail || '');
    if (!email) return;
    const signedAt = item.signedAt?.toDate ? item.signedAt.toDate() : item.signedAtIso ? new Date(item.signedAtIso) : item.signedAt ? new Date(item.signedAt) : null;
    known.set(email, {
      email,
      status: item.status === 'signed' ? 'signed' : 'pending',
      displayName: item.displayName || item.signedByName || '',
      signedAtText: signedAt && !Number.isNaN(signedAt.getTime()) ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(signedAt) : 'Fecha no disponible',
      isCurrent: email === current,
    });
  });
  const emails = [...new Set([...(docu.signerEmails || []), ...(docu.allSignerEmails || []), ...(docu.signatureFields || []).map((f) => f.signerEmail)].map(normalizeEmail).filter(Boolean))];
  emails.forEach((email) => {
    if (!known.has(email)) known.set(email, { email, status: 'pending', displayName: '', signedAtText: '', isCurrent: email === current });
  });
  return [...known.values()].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.email.localeCompare(b.email));
}

async function ensureServerArtifactForDoc(projectId, docId, docu, type) {
  // Siempre regeneramos artefactos para usar el último motor de estampado del servidor.
  const generateArtifacts = httpsCallable(functions, 'generateDocumentArtifacts');
  const result = await generateArtifacts({ projectId, docId });
  const data = result.data || {};
  const path = type === 'signed' ? data.signedPdfPath : data.certificatePdfPath;
  if (!path) throw new Error('La función no devolvió la ruta del archivo generado.');
  return path;
}

async function downloadStoragePath(path, filename) {
  const u = await getDownloadURL(ref(storage, path));
  const response = await fetch(u);
  if (!response.ok) throw new Error(`Storage respondió ${response.status}`);
  const blob = await response.blob();
  downloadBytes(filename, blob, blob.type || 'application/pdf');
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
  const boxW = Math.min(width - 24, Math.max(180, Number(field.w || 0.2) * width));
  const boxH = Math.min(height - 24, Math.max(70, Number(field.h || 0.08) * height));
  const rawX = Number(field.x || 0) * width;
  const rawY = height - (Number(field.y || 0) * height) - boxH;
  const x = Math.max(12, Math.min(width - boxW - 12, rawX));
  const y = Math.max(12, Math.min(height - boxH - 12, rawY));
  const pad = Math.max(4, Math.min(8, boxH * 0.10));
  const canShowMeta = true;
  const metaH = canShowMeta ? Math.min(24, Math.max(15, boxH * 0.30)) : 0;

  page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: rgb(0.08, 0.08, 0.08), borderWidth: 0.9, color: rgb(1, 1, 1), opacity: 0.94 });
  if (canShowMeta) {
    page.drawLine({ start: { x: x + pad, y: y + metaH + 1 }, end: { x: x + boxW - pad, y: y + metaH + 1 }, thickness: 0.5, color: rgb(0.1, 0.1, 0.1) });
  }

  const signatureAreaH = Math.max(8, boxH - metaH - pad * 1.5);
  const signatureY = y + metaH + Math.max(2, pad * 0.45);
  if (sig.signatureType === 'drawn' && sig.signatureImage) {
    try {
      const png = await pdfDoc.embedPng(dataUrlToBytes(sig.signatureImage));
      const dims = fitImage(png, boxW - pad * 2, signatureAreaH - 2);
      page.drawImage(png, { x: x + (boxW - dims.width) / 2, y: signatureY + Math.max(0, (signatureAreaH - dims.height) / 2), width: dims.width, height: dims.height });
    } catch (err) {
      drawFittedText(page, sig.displayName || sig.typedName || sig.email || 'Firma', fonts.italic, x + pad, signatureY + signatureAreaH * 0.38, boxW - pad * 2, Math.min(22, signatureAreaH * 0.55), 6);
    }
  } else {
    drawFittedText(page, sig.typedName || sig.displayName || sig.email || 'Firma', fonts.italic, x + pad, signatureY + signatureAreaH * 0.35, boxW - pad * 2, Math.min(24, Math.max(10, signatureAreaH * 0.55)), 6);
  }

  if (canShowMeta) {
    const line1 = `DNI ${sig.dni || '-'} · ${sig.displayName || sig.typedName || 'Firmante'}`;
    const line2 = `${sig.email || '-'} · ${compactDate(sig)}`;
    const size1 = Math.min(6.6, Math.max(4.6, metaH * 0.26));
    const size2 = Math.min(5.8, Math.max(4.2, metaH * 0.22));
    drawFittedText(page, line1, fonts.bold, x + pad, y + metaH - size1 - 2, boxW - pad * 2, size1, 4);
    drawFittedText(page, line2, fonts.regular, x + pad, y + 3.2, boxW - pad * 2, size2, 4);
  }
}

function drawFittedText(page, text, font, x, y, maxWidth, maxSize, minSize = 4) {
  const size = fitTextSize(font, text, maxWidth, maxSize, minSize);
  const clean = truncateToWidth(font, text, maxWidth, size);
  page.drawText(clean, { x, y, size, font, color: rgb(0.06, 0.06, 0.06), maxWidth });
}

function fitTextSize(font, text, maxWidth, maxSize, minSize = 4) {
  let size = Math.max(minSize, maxSize);
  while (size > minSize && font.widthOfTextAtSize(String(text || ''), size) > maxWidth) size -= 0.5;
  return Math.max(minSize, size);
}

function truncateToWidth(font, text, maxWidth, size) {
  const value = String(text || '');
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let next = value;
  while (next.length > 3 && font.widthOfTextAtSize(`${next}…`, size) > maxWidth) next = next.slice(0, -1);
  return `${next}…`;
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
      const normalizedFields = normalizeSignatureFields(fields);
      await updateDoc(doc(db, 'projects', project.id, 'documents', docu.id), { signatureFields: normalizedFields, updatedAt: serverTimestamp() });
      await createSignatureRequests(project, { ...docu, signatureFields: normalizedFields });
      onClose();
    } finally { setBusy(false); }
  }
  return <div className="editorRow"><Card>
    <div className="cardHead"><h3>Campos de firma: {docu.title}</h3><Button variant="ghost" onClick={onClose}>Cerrar</Button></div>
    {url ? <SignatureFieldDesigner fileUrl={url} fileName={docu.fileName} contentType={docu.contentType} signerEmails={docu.signerEmails || []} fields={fields} onChange={setFields}/> : <p>Cargando vista previa...</p>}
    <div className="actions"><Button onClick={save} disabled={busy}>{busy ? 'Guardando...' : 'Guardar campos'}</Button></div>
  </Card></div>;
}

function PendingDoc({ request, user, directOpen = false }) {
  const [signed, setSigned] = useState(false);
  const [open, setOpen] = useState(Boolean(directOpen));
  const blockRef = useRef(null);
  const [docu, setDocu] = useState(null);
  const [downloadBusy, setDownloadBusy] = useState('');

  useEffect(() => {
    if (directOpen) {
      setOpen(true);
      setTimeout(() => blockRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 200);
    }
  }, [directOpen]);

  useEffect(() => onSnapshot(doc(db, 'projects', request.projectId, 'documents', request.docId, 'signatures', user.uid), (snap) => setSigned(snap.exists()),
    (err) => console.warn('No se pudo cargar estado de firma:', err.message)), [request.projectId, request.docId, user.uid]);

  useEffect(() => onSnapshot(doc(db, 'projects', request.projectId, 'documents', request.docId), (snap) => {
    if (snap.exists()) setDocu({ id: snap.id, projectId: request.projectId, ...snap.data() });
  }, (err) => console.warn('No se pudo cargar documento asignado:', err.message)), [request.projectId, request.docId]);

  async function downloadArtifact(type) {
    if (!docu) return;
    setDownloadBusy(type);
    try {
      const isSigned = type === 'signed';
      if (isSigned && !isPdfDocument(docu)) {
        alert('La descarga de PDF firmado por ahora está disponible para documentos PDF.');
        return;
      }
      const path = await ensureServerArtifactForDoc(request.projectId, request.docId, docu, type);
      const suffix = isSigned ? 'firmado-gb-sign.pdf' : 'certificado-evidencia-gb-sign.pdf';
      await downloadStoragePath(path, `${safeFileName(docu.title || request.title)}-${suffix}`);
    } catch (err) {
      console.error(err);
      alert(`No se pudo descargar el archivo: ${err.message || err}`);
    } finally {
      setDownloadBusy('');
    }
  }

  const statusLabel = signed ? 'Firmado por vos' : 'Pendiente de tu firma';

  return <div className={`pendingBlock ${directOpen ? 'directTarget' : ''}`} ref={blockRef}>
    <div className="pending">
      <div>
        <strong>{request.title}</strong>
        <small>{request.projectName || 'Proyecto'} · {request.fileName}<br/>Hash: {request.sha256}</small>
      </div>
      <div className="actions">
        <Badge tone={signed ? 'good' : 'warn'}>{signed ? <CheckCircle2 size={14}/> : null}{statusLabel}</Badge>
        <Button onClick={() => setOpen((v)=>!v)}>{open ? 'Cerrar' : signed ? 'Ver estado y descargas' : 'Abrir para firmar'}</Button>
      </div>
    </div>
    {open && <Card className="signerStatusCard">
      <SignatureStatusPanel docu={docu || request} currentEmail={user.email}/>
      {signed && <div className="actions signerDownloads">
        <Button variant="ghost" onClick={() => downloadArtifact('signed')} disabled={downloadBusy === 'signed'}>
          <Download size={16}/>{downloadBusy === 'signed' ? 'Preparando...' : 'Descargar PDF firmado'}
        </Button>
        <Button variant="ghost" onClick={() => downloadArtifact('certificate')} disabled={downloadBusy === 'certificate'}>
          <Download size={16}/>{downloadBusy === 'certificate' ? 'Preparando...' : 'Descargar certificado'}
        </Button>
      </div>}
    </Card>}
    {open && !signed && <SigningRoom request={request} user={user} docu={docu}/>} 
  </div>;
}

function SignatureStatusPanel({ docu, currentEmail }) {
  const rows = signatureStatusRows(docu || {}, currentEmail);
  if (!rows.length) return <p className="muted">Todavía no hay información de firmantes para este documento.</p>;
  const total = rows.length;
  const signedCount = rows.filter((r) => r.status === 'signed').length;
  return <div className="signatureStatusPanel">
    <div className="statusSummary">
      <strong>Estado de firmas</strong>
      <Badge tone={signedCount === total ? 'good' : 'warn'}>{signedCount}/{total} firmado</Badge>
    </div>
    <div className="signerStatusList">
      {rows.map((r) => <div className={`signerStatusItem ${r.isCurrent ? 'current' : ''}`} key={r.email}>
        <div>
          <strong>{r.email}{r.isCurrent ? ' · vos' : ''}</strong>
          <small>{r.status === 'signed' ? `${r.displayName ? `${r.displayName} · ` : ''}${r.signedAtText}` : 'Pendiente de firma'}</small>
        </div>
        <Badge tone={r.status === 'signed' ? 'good' : 'warn'}>{r.status === 'signed' ? 'Firmado' : 'Pendiente'}</Badge>
      </div>)}
    </div>
  </div>;
}



function MobileSignRoute({ requestId, pending, user }) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const t = setTimeout(() => setWaited(true), 1400);
    return () => clearTimeout(t);
  }, [requestId, user?.uid]);
  const request = pending.find((item) => item.id === requestId);
  if (!request && !waited) {
    return <main className="mobileSignShell"><Card className="mobileSignCard"><ShieldCheck size={38}/><h1>GB Sign</h1><p>Buscando solicitud de firma...</p></Card></main>;
  }
  if (!request) {
    return <main className="mobileSignShell"><Card className="mobileSignCard"><ShieldCheck size={38}/><h1>GB Sign</h1><p>No encontramos esta solicitud para <strong>{normalizeEmail(user.email)}</strong>.</p><p className="muted">Verificá que hayas iniciado sesión con el mismo Google que fue invitado a firmar.</p><Button variant="ghost" onClick={() => signOut(auth)}><LogOut size={16}/> Cambiar cuenta</Button></Card></main>;
  }
  return <main className="mobileSignShell"><MobileSignatureOnly request={request} user={user}/></main>;
}

function MobileQrPrompt({ link }) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(link, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch((err) => console.warn('No se pudo generar QR mobile:', err.message));
    return () => { cancelled = true; };
  }, [link]);
  return <div className="mobileQrPrompt">
    <div><strong><Smartphone size={16}/> Firmar desde celular</strong><span>Escaneá este QR. En el celular se abre solo el recuadro de firma para dibujar con el dedo y confirmar.</span></div>
    {qrDataUrl ? <img src={qrDataUrl} alt="QR para firmar desde celular"/> : <span className="muted">Generando QR...</span>}
  </div>;
}

function MobileSignatureOnly({ request, user }) {
  const [docu, setDocu] = useState(null);
  const [signed, setSigned] = useState(false);
  const [fieldPressed, setFieldPressed] = useState(false);
  const [signatureImage, setSignatureImage] = useState('');
  const [dni, setDni] = useState('');
  const [dniConfirmed, setDniConfirmed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const cleanDni = normalizeDni(dni);
  const fields = (request.signatureFields || []).filter((f) => normalizeEmail(f.signerEmail) === normalizeEmail(user.email));
  const activeField = fields[0] || null;

  useEffect(() => onSnapshot(doc(db, 'projects', request.projectId, 'documents', request.docId), (snap) => {
    if (snap.exists()) setDocu({ id: snap.id, projectId: request.projectId, ...snap.data() });
  }, (err) => console.warn('No se pudo cargar documento mobile:', err.message)), [request.projectId, request.docId]);

  useEffect(() => onSnapshot(doc(db, 'projects', request.projectId, 'documents', request.docId, 'signatures', user.uid), (snap) => setSigned(snap.exists()),
    (err) => console.warn('No se pudo cargar firma mobile:', err.message)), [request.projectId, request.docId, user.uid]);

  async function submit() {
    if (!activeField || !fieldPressed) { alert('Primero tocá el recuadro naranja para firmar.'); return; }
    if (!signatureImage) { alert('Dibujá tu firma con el dedo.'); return; }
    if (!cleanDni || cleanDni.length < 6) { alert('Completá tu DNI con números.'); return; }
    if (!dniConfirmed) { alert('Confirmá que el DNI ingresado es correcto.'); return; }
    if (!consent) { alert('Aceptá el consentimiento de firma electrónica.'); return; }
    setBusy(true);
    try {
      const signDocument = httpsCallable(functions, 'signDocument');
      await signDocument({
        projectId: request.projectId,
        docId: request.docId,
        requestId: request.id,
        fieldId: activeField.id,
        signatureField: activeField,
        signatureType: 'drawn',
        signatureImage,
        typedName: '',
        dni: cleanDni,
        dniEntered: dni.trim(),
        acceptedText: ACCEPTANCE_TEXT,
        clientEvidence: {
          userAgent: navigator.userAgent,
          screen: { width: window.screen?.width || null, height: window.screen?.height || null, pixelRatio: window.devicePixelRatio || 1 },
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
          language: navigator.language || '',
          mobileQrFlow: true,
        },
      });
      setSigned(true);
    } catch (err) {
      console.error(err);
      alert(err?.message || 'No se pudo completar la firma.');
    } finally { setBusy(false); }
  }

  if (signed) return <Card className="mobileSignCard success"><CheckCircle2 size={46}/><h1>Firma enviada</h1><p>Tu firma fue registrada correctamente. La computadora donde estaba abierto el documento se actualizará automáticamente.</p><small>{docu?.title || request.title}</small></Card>;

  return <Card className="mobileSignCard">
    <div className="mobileSignTop"><ShieldCheck size={34}/><div><h1>Firmar con el dedo</h1><p>{docu?.title || request.title || 'Documento'}</p></div></div>
    <button type="button" className={`mobileFieldBox ${fieldPressed ? 'done' : ''}`} onClick={() => setFieldPressed(true)}>
      <span>{fieldPressed ? 'Recuadro seleccionado' : 'Tocá este recuadro para firmar'}</span>
    </button>
    {fieldPressed && <>
      <SignaturePad onChange={setSignatureImage}/>
      <Field label="DNI"><input inputMode="numeric" value={dni} onChange={(e)=>setDni(e.target.value)} placeholder="Ej: 34553626"/></Field>
      <label className="check compactCheck"><input type="checkbox" checked={dniConfirmed} onChange={(e)=>setDniConfirmed(e.target.checked)}/><span>Confirmo que este DNI es correcto.</span></label>
      <label className="check compactCheck"><input type="checkbox" checked={consent} onChange={(e)=>setConsent(e.target.checked)}/><span>{ACCEPTANCE_TEXT}</span></label>
      <Button onClick={submit} disabled={busy || !signatureImage}>{busy ? 'Enviando firma...' : 'Confirmar firma'}</Button>
    </>}
    {!activeField && <p className="muted">No hay un campo de firma asignado a este mail.</p>}
  </Card>;
}

function SigningRoom({ request, user, docu }) {
  const [url, setUrl] = useState('');
  const [activeFieldId, setActiveFieldId] = useState('');
  const [fieldClicked, setFieldClicked] = useState(false);
  const [signatureMode, setSignatureMode] = useState('drawn');
  const [typedName, setTypedName] = useState(user.displayName || '');
  const [signatureImage, setSignatureImage] = useState('');
  const [dni, setDni] = useState('');
  const [dniConfirmed, setDniConfirmed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const fields = (request.signatureFields || []).filter((f) => normalizeEmail(f.signerEmail) === normalizeEmail(user.email));
  const activeField = fields.find((f) => f.id === activeFieldId) || null;
  const cleanDni = normalizeDni(dni);
  const mobileLink = mobileSigningLink(request.id);

  useEffect(() => {
    getDownloadURL(ref(storage, request.storagePath)).then(setUrl).catch((err) => console.warn('No se pudo abrir el documento:', err.message));
  }, [request.storagePath]);


  function selectSignatureField(fieldId) {
    setActiveFieldId(fieldId);
    setFieldClicked(true);
  }

  async function sign() {
    if (!fieldClicked || !activeField) { alert('Primero tenés que presionar el recuadro naranja de firma dentro del documento.'); return; }
    if (!cleanDni || cleanDni.length < 6) { alert('Completá tu DNI con números.'); return; }
    if (!dniConfirmed) { alert('Tenés que confirmar que el DNI ingresado es correcto.'); return; }
    if (!consent) { alert('Tenés que aceptar el consentimiento de firma electrónica.'); return; }
    if (signatureMode === 'drawn' && !signatureImage) { alert('Dibujá tu firma o elegí la firma cursiva por nombre.'); return; }
    if (signatureMode === 'typed' && !typedName.trim()) { alert('Completá tu nombre para la firma cursiva.'); return; }
    setBusy(true);
    try {
      const signDocument = httpsCallable(functions, 'signDocument');
      await signDocument({
        projectId: request.projectId,
        docId: request.docId,
        requestId: request.id,
        fieldId: activeField.id,
        signatureField: activeField,
        signatureType: signatureMode,
        signatureImage: signatureMode === 'drawn' ? signatureImage : '',
        typedName: signatureMode === 'typed' ? typedName.trim() : '',
        dni: cleanDni,
        dniEntered: dni.trim(),
        acceptedText: ACCEPTANCE_TEXT,
        clientEvidence: {
          userAgent: navigator.userAgent,
          screen: { width: window.screen?.width || null, height: window.screen?.height || null, pixelRatio: window.devicePixelRatio || 1 },
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
          language: navigator.language || '',
        },
      });
    } catch (err) {
      console.error(err);
      alert(err?.message || 'No se pudo completar la firma.');
    } finally { setBusy(false); }
  }


  return <Card className="signingRoom">
    <div className="cardHead"><h3>Revisar y firmar</h3><Badge tone="warn">Firma electrónica</Badge></div>
    <div className={`signStepNotice ${fieldClicked ? 'done' : ''}`}><strong>{fieldClicked ? 'Recuadro seleccionado' : 'Paso obligatorio: presioná el recuadro naranja de firma'}</strong><span>{fieldClicked ? 'Ya podés completar tu DNI y confirmar la firma.' : 'Para dejar constancia de intención, tocá/clickeá el recuadro asignado dentro del documento antes de avanzar.'}</span></div>
    <MobileQrPrompt link={mobileLink} />
    {url ? <DocumentPreview url={url} fileName={request.fileName} contentType={request.contentType} fields={fields} activeFieldId={activeFieldId} onSelectField={selectSignatureField} signatures={buildPreviewSignatures(fieldClicked ? activeField : null, signatureMode, signatureImage, typedName)}/> : <p>Cargando documento...</p>}
    <div className="grid two signControls">
      <Card>
        <h3>Campo asignado</h3>
        {fields.length ? <div className="chips">{fields.map((f, idx) => <span className={`chip chipButton ${fieldClicked && f.id === activeFieldId ? 'active' : ''}`} key={f.id}>Campo {idx + 1} · {fieldClicked && f.id === activeFieldId ? 'seleccionado' : 'tocá el recuadro en el documento'}</span>)}</div> : <p className="muted">No hay un recuadro asignado a tu mail. Pedile al administrador que configure el campo de firma.</p>}
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
    <div className="actions"><Button onClick={sign} disabled={busy || !fieldClicked || !activeField}>{busy ? 'Firmando...' : fieldClicked ? 'Confirmar firma electrónica' : 'Primero presioná el recuadro'}</Button></div>
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
    const next = normalizeDraftBox({
      ...base,
      x: Math.min(base.sx, p.x),
      y: Math.min(base.sy, p.y),
      w: Math.abs(p.x - base.sx),
      h: Math.abs(p.y - base.sy),
    });
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
    const boxedDraft = normalizeDraftBox(finalDraft);
    const clean = normalizeEmail(activeEmail);
    const nextField = {
      id: `field_${emailKey(clean)}`,
      signerEmail: clean,
      label: `Firma de ${clean}`,
      page: Number(boxedDraft.page) || 1,
      x: round(boxedDraft.x), y: round(boxedDraft.y), w: round(boxedDraft.w), h: round(boxedDraft.h),
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
      <div className="designerHint"><strong>Cómo marcar el campo:</strong><br/>Primero navegá y scrolleá el documento. Cuando estés en el lugar correcto, tocá <strong>Colocar recuadro</strong> y arrastrá sobre la firma. La app aplica un tamaño mínimo para que entren firma, DNI, nombre y fecha.</div>
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

function normalizeDraftBox(box) {
  if (!box) return box;
  const sx = Number.isFinite(box.sx) ? box.sx : box.x;
  const sy = Number.isFinite(box.sy) ? box.sy : box.y;
  const toRight = box.x >= sx;
  const toDown = box.y >= sy;
  const w = Math.max(Number(box.w || 0), MIN_SIGNATURE_FIELD_W);
  const h = Math.max(Number(box.h || 0), MIN_SIGNATURE_FIELD_H);
  let x = toRight ? sx : sx - w;
  let y = toDown ? sy : sy - h;
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { ...box, x, y, w, h };
}

function normalizeSignatureFields(fields = []) {
  return (fields || []).map((field) => {
    const normalized = normalizeDraftBox({ ...field, sx: field.x, sy: field.y });
    return { ...field, x: round(normalized.x), y: round(normalized.y), w: round(normalized.w), h: round(normalized.h), minVersion: 'gb-sign-field-v2' };
  });
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
    {pageDraft && <div className="signatureRect draft" style={rectStyle(pageDraft)}><span>Nuevo campo · mínimo recomendado</span></div>}
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

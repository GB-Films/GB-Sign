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
import { auth, db, provider, storage } from './firebase';
import { Badge, Button, Card, Empty, Field } from './components.jsx';
import {
  downloadText, emailKey, fmtDate, normalizeEmail, parseEmails,
  sha256File, signatureRequestId, statusFor
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
  const [editFields, setEditFields] = useState(false);
  const tone = statusFor(docu, signatures) === 'Completo' ? 'good' : 'warn';
  async function openFile() {
    const u = await getDownloadURL(ref(storage, docu.storagePath));
    setUrl(u); window.open(u, '_blank', 'noopener,noreferrer');
  }
  function evidence() {
    const payload = {
      certificateType: 'GB Sign electronic signature evidence',
      generatedAt: new Date().toISOString(),
      document: docu,
      signatures,
    };
    downloadText(`evidencia-${docu.title}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }
  async function syncRequests() {
    setBusy(true);
    try { await createSignatureRequests(project, docu); }
    finally { setBusy(false); }
  }
  return <>
    <div className="tr"><span><strong>{docu.title}</strong><small>{docu.fileName}<br/>SHA-256: {docu.sha256}<br/>Campos de firma: {(docu.signatureFields || []).length}</small></span><span>{(docu.signerEmails || []).map((e)=><small key={e}>{e}</small>)}</span><span><Badge tone={tone}>{statusFor(docu, signatures)}</Badge></span><span className="actions"><Button variant="ghost" onClick={openFile}><Download size={16}/> Ver</Button><Button variant="ghost" onClick={() => setEditFields((v)=>!v)}><PenLine size={16}/> Campos</Button><Button variant="ghost" onClick={syncRequests} disabled={busy}>{busy ? 'Activando...' : 'Activar firmantes'}</Button><Button variant="ghost" onClick={evidence}>Evidencia</Button>{url && <a href={url}>link</a>}</span></div>
    {editFields && <EditSignatureFields project={project} docu={docu} onClose={() => setEditFields(false)}/>} 
  </>;
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
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const fields = (request.signatureFields || []).filter((f) => normalizeEmail(f.signerEmail) === normalizeEmail(user.email));
  const activeField = fields.find((f) => f.id === activeFieldId) || fields[0] || null;

  useEffect(() => {
    getDownloadURL(ref(storage, request.storagePath)).then(setUrl).catch((err) => console.warn('No se pudo abrir el documento:', err.message));
  }, [request.storagePath]);

  useEffect(() => {
    if (!activeFieldId && fields[0]) setActiveFieldId(fields[0].id);
  }, [fields, activeFieldId]);

  async function sign() {
    if (!activeField) { alert('No hay campo de firma asignado para tu mail.'); return; }
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
        documentSha256: request.sha256,
        fieldId: activeField.id,
        signatureField: activeField,
        signatureType: signatureMode,
        signatureImage: signatureMode === 'drawn' ? signatureImage : '',
        typedName: signatureMode === 'typed' ? typedName.trim() : '',
        renderedSignature,
        consentElectronicSignature: true,
        intentAction: 'El firmante abrió el documento, presionó su campo de firma asignado y confirmó la firma electrónica.',
        acceptedText: ACCEPTANCE_TEXT,
        userAgent: navigator.userAgent,
        screen: { width: window.screen?.width || null, height: window.screen?.height || null, pixelRatio: window.devicePixelRatio || 1 },
        signedAt: serverTimestamp(),
      });
    } finally { setBusy(false); }
  }

  return <Card className="signingRoom">
    <div className="cardHead"><h3>Revisar y firmar</h3><Badge tone="warn">Firma electrónica</Badge></div>
    <p className="muted">Presioná el recuadro asignado dentro del documento. Luego dibujá tu firma o usá una firma cursiva generada con tu nombre.</p>
    {url ? <DocumentPreview url={url} fileName={request.fileName} contentType={request.contentType} fields={fields} activeFieldId={activeFieldId} onSelectField={setActiveFieldId} signatures={buildPreviewSignatures(activeField, signatureMode, signatureImage, typedName)}/> : <p>Cargando documento...</p>}
    <div className="grid two signControls">
      <Card>
        <h3>Campo asignado</h3>
        {fields.length ? <div className="chips">{fields.map((f) => <button type="button" className={`chip chipButton ${f.id === activeFieldId ? 'active' : ''}`} key={f.id} onClick={() => setActiveFieldId(f.id)}>Página {f.page || 1} · {f.label || 'Firma'}</button>)}</div> : <p className="muted">No hay un recuadro asignado a tu mail. Pedile al administrador que configure el campo de firma.</p>}
      </Card>
      <Card>
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
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState(null);
  const overlayRef = useRef(null);
  const drawingRef = useRef(null);

  useEffect(() => {
    if (!signerEmails.includes(activeEmail)) setActiveEmail(signerEmails[0] || '');
  }, [signerEmails, activeEmail]);

  function point(ev) {
    const rect = overlayRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
    return { x, y };
  }

  function start(ev) {
    if (!activeEmail || !overlayRef.current) return;
    ev.preventDefault();
    ev.stopPropagation();
    overlayRef.current.setPointerCapture?.(ev.pointerId);
    const p = point(ev);
    const next = { sx: p.x, sy: p.y, x: p.x, y: p.y, w: 0, h: 0 };
    drawingRef.current = next;
    setDraft(next);
  }

  function move(ev) {
    if (!drawingRef.current || !overlayRef.current) return;
    ev.preventDefault();
    const p = point(ev);
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
    if (!finalDraft || finalDraft.w < 0.025 || finalDraft.h < 0.018) return;
    const clean = normalizeEmail(activeEmail);
    const nextField = {
      id: `field_${emailKey(clean)}`,
      signerEmail: clean,
      label: `Firma de ${clean}`,
      page: Number(page) || 1,
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
    <div className="designerToolbar">
      <Field label="Firmante"><select value={activeEmail} onChange={(e)=>setActiveEmail(e.target.value)}>{signerEmails.map((e)=><option value={e} key={e}>{e}</option>)}</select></Field>
      <Field label="Página"><input type="number" min="1" value={page} onChange={(e)=>setPage(e.target.value)}/></Field>
      <div className="designerHint"><strong>Cómo marcar el campo:</strong><br/>Elegí el firmante y arrastrá sobre la vista previa del documento. El recuadro queda asociado solo a ese mail.</div>
    </div>
    <div className="docPreview designer">
      <PreviewSurface url={fileUrl} fileName={fileName} contentType={contentType} page={page}/>
      <SignatureOverlay
        fields={fields || []}
        activeFieldId={`field_${emailKey(activeEmail)}`}
        draft={draft}
        designer
        overlayRef={overlayRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
    <div className="fieldStatus">
      {signerEmails.map((email) => {
        const field = (fields || []).find((f) => normalizeEmail(f.signerEmail) === normalizeEmail(email));
        return <div className="fieldStatusItem" key={email}><span>{email}</span>{field ? <Badge tone="good">Campo marcado · pág. {field.page}</Badge> : <Badge tone="warn">Falta campo</Badge>}{field && <Button variant="ghost" type="button" onClick={() => remove(email)}>Borrar</Button>}</div>;
      })}
    </div>
  </div>;
}

function DocumentPreview({ url, fileName, contentType, fields, activeFieldId, onSelectField, signatures = [] }) {
  return <div className="docPreview readonly">
    <PreviewSurface url={url} fileName={fileName} contentType={contentType}/>
    <SignatureOverlay fields={fields || []} activeFieldId={activeFieldId} onSelectField={onSelectField} signatures={signatures}/>
  </div>;
}

function PreviewSurface({ url, fileName, contentType, page = 1 }) {
  const isImage = (contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(fileName || '');
  const isPdf = (contentType || '').includes('pdf') || /\.pdf$/i.test(fileName || '');
  if (isImage) return <img className="previewFile" src={url} alt={fileName || 'Documento'} draggable="false"/>;
  if (isPdf) return <iframe className="previewFile" src={`${url}#toolbar=0&navpanes=0&scrollbar=0&page=${page}&zoom=page-fit`} title={fileName || 'Documento'} />;
  return <div className="previewFallback"><strong>{fileName}</strong><p>La vista previa completa depende del navegador. Abrí el documento original para revisar el contenido antes de firmar.</p></div>;
}

function SignatureOverlay({ fields, activeFieldId, onSelectField, draft, signatures = [], designer = false, overlayRef, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }) {
  return <div
    ref={overlayRef}
    className={`signatureOverlay ${designer ? 'designerOverlay' : ''}`}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
    onPointerLeave={onPointerUp}
  >
    {(fields || []).map((f) => designer
      ? <div key={f.id} className={`signatureRect ${f.id === activeFieldId ? 'active' : ''}`} style={rectStyle(f)}><span>{f.label || f.signerEmail}</span></div>
      : <button type="button" key={f.id} className={`signatureRect ${f.id === activeFieldId ? 'active' : ''}`} style={rectStyle(f)} onClick={(e) => { e.preventDefault(); onSelectField?.(f.id); }}>
        <span>{f.label || f.signerEmail}</span>
      </button>
    )}
    {signatures.map((sig) => <div key={sig.field.id} className="signatureVisual" style={rectStyle(sig.field)}>{sig.type === 'drawn' ? <img src={sig.image} alt="Firma"/> : <span>{sig.typedName}</span>}</div>)}
    {draft && <div className="signatureRect draft" style={rectStyle(draft)}><span>Nuevo campo</span></div>}
  </div>;
}

function rectStyle(f) {
  return { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
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

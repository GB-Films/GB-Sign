import React, { useEffect, useMemo, useState } from 'react';
import {
  addDoc, collection, doc, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  CheckCircle2, ClipboardCopy, Download, FileSignature, FolderPlus,
  LockKeyhole, LogOut, ShieldCheck, Upload, Users
} from 'lucide-react';
import { auth, db, provider, storage } from './firebase';
import { Badge, Button, Card, Empty, Field } from './components.jsx';
import {
  downloadText, emailKey, fmtDate, normalizeEmail, parseEmails,
  sha256File, signatureRequestId, statusFor
} from './utils.js';

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
  return <section className="project">
    <div className="sectionTitle"><h2>{project.name}</h2><Badge>{project.client || 'Proyecto interno'}</Badge></div>
    <section className="grid two">
      <Card><div className="cardHead"><h3>Cargar documento y solicitar firmas</h3><Upload size={22}/></div><UploadDocument project={project}/></Card>
      <Card><div className="cardHead"><h3>Colaboradores internos</h3><Users size={22}/></div><Members project={project} currentUser={user} canManage={canManageMembers}/></Card>
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
    const requestRef = doc(db, 'signatureRequests', signatureRequestId(project.id, docu.id, signerEmail));
    batch.set(requestRef, {
      projectId: project.id,
      projectName: project.name || '',
      projectClient: project.client || '',
      docId: docu.id,
      title: docu.title,
      fileName: docu.fileName,
      storagePath: docu.storagePath || '',
      sha256: docu.sha256,
      signerEmail: normalizeEmail(signerEmail),
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
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!file || !title.trim()) return;
    setBusy(true);
    try {
      const signerEmails = parseEmails(emails);
      const hash = await sha256File(file);
      const docRef = await addDoc(collection(db, 'projects', project.id, 'documents'), {
        title: title.trim(), fileName: file.name, contentType: file.type || 'application/octet-stream', size: file.size,
        sha256: hash, signerEmails, uploadedByUid: auth.currentUser.uid, uploadedByEmail: normalizeEmail(auth.currentUser.email),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      const storagePath = `projects/${project.id}/documents/${docRef.id}/${file.name}`;
      await uploadBytes(ref(storage, storagePath), file, { contentType: file.type, customMetadata: { projectId: project.id, docId: docRef.id, sha256: hash } });
      const docPayload = { id: docRef.id, projectId: project.id, title: title.trim(), fileName: file.name, storagePath, sha256: hash, signerEmails };
      await updateDoc(docRef, { storagePath, updatedAt: serverTimestamp() });
      await createSignatureRequests(project, docPayload);
      setTitle(''); setEmails(''); setFile(null);
    } finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={submit}>
    <Field label="Título"><input value={title} onChange={(e)=>setTitle(e.target.value)} placeholder="Ej: Cesión de imagen - Actor"/></Field>
    <Field label="Mails de Google de firmantes externos" hint="Estos correos solo podrán ver y firmar este documento puntual. No son colaboradores internos."><textarea value={emails} onChange={(e)=>setEmails(e.target.value)} placeholder="persona@gmail.com, otra@empresa.com"/></Field>
    <Field label="Archivo"><input type="file" onChange={(e)=>setFile(e.target.files?.[0] || null)}/></Field>
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
  const tone = statusFor(docu, signatures) === 'Completo' ? 'good' : 'warn';
  async function openFile() {
    const u = await getDownloadURL(ref(storage, docu.storagePath));
    setUrl(u); window.open(u, '_blank', 'noopener,noreferrer');
  }
  function evidence() {
    const payload = { document: docu, signatures };
    downloadText(`evidencia-${docu.title}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }
  async function syncRequests() {
    setBusy(true);
    try { await createSignatureRequests(project, docu); }
    finally { setBusy(false); }
  }
  return <div className="tr"><span><strong>{docu.title}</strong><small>{docu.fileName}<br/>SHA-256: {docu.sha256}</small></span><span>{(docu.signerEmails || []).map((e)=><small key={e}>{e}</small>)}</span><span><Badge tone={tone}>{statusFor(docu, signatures)}</Badge></span><span className="actions"><Button variant="ghost" onClick={openFile}><Download size={16}/> Ver</Button><Button variant="ghost" onClick={syncRequests} disabled={busy}>{busy ? 'Activando...' : 'Activar firmantes'}</Button><Button variant="ghost" onClick={evidence}>Evidencia</Button>{url && <a href={url}>link</a>}</span></div>;
}

function PendingDoc({ request, user }) {
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => onSnapshot(doc(db, 'projects', request.projectId, 'documents', request.docId, 'signatures', user.uid), (snap) => setSigned(snap.exists()),
    (err) => console.warn('No se pudo cargar estado de firma:', err.message)), [request.projectId, request.docId, user.uid]);
  async function view() { window.open(await getDownloadURL(ref(storage, request.storagePath)), '_blank', 'noopener,noreferrer'); }
  async function sign() {
    setBusy(true);
    try {
      await setDoc(doc(db, 'projects', request.projectId, 'documents', request.docId, 'signatures', user.uid), {
        uid: user.uid,
        email: normalizeEmail(user.email),
        displayName: user.displayName || '',
        documentSha256: request.sha256,
        acceptedText: 'Declaro que revisé el documento indicado y acepto firmarlo electrónicamente con mi cuenta Google autenticada.',
        userAgent: navigator.userAgent,
        signedAt: serverTimestamp(),
      });
    } finally { setBusy(false); }
  }
  return <div className="pending"><div><strong>{request.title}</strong><small>{request.projectName || 'Proyecto'} · {request.fileName}<br/>Hash: {request.sha256}</small></div><div className="actions"><Button variant="ghost" onClick={view}>Ver</Button>{signed ? <Badge tone="good"><CheckCircle2 size={14}/> Firmado</Badge> : <Button onClick={sign} disabled={busy}>{busy ? 'Firmando...' : 'Firmar'}</Button>}</div></div>;
}

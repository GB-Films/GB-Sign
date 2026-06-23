import React, { useEffect, useMemo, useState } from 'react';
import {
  addDoc, collection, collectionGroup, deleteDoc, doc, getDocs, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { FileSignature, FolderPlus, LogOut, Upload, Users, CheckCircle2, Download, ShieldCheck } from 'lucide-react';
import { auth, db, provider, storage } from './firebase';
import { Badge, Button, Card, Empty, Field } from './components.jsx';
import { downloadText, fmtDate, normalizeEmail, parseEmails, sha256File, statusFor } from './utils.js';

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

export default function App() {
  const { user, loading } = useAuth();
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
    const unsubOwned = onSnapshot(ownedQ, (snap) => { snap.docs.forEach((d) => cache.set(d.id, { id: d.id, ...d.data() })); publish(); });
    const unsubShared = onSnapshot(sharedQ, (snap) => { snap.docs.forEach((d) => cache.set(d.id, { id: d.id, ...d.data() })); publish(); });
    return () => { unsubOwned(); unsubShared(); };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const q = query(collectionGroup(db, 'documents'), where('signerEmails', 'array-contains', normalizeEmail(user.email)));
    return onSnapshot(q, (snap) => setPending(snap.docs.map((d) => ({ id: d.id, projectId: d.ref.parent.parent.id, ...d.data() }))));
  }, [user]);

  useEffect(() => {
    if (!selectedProjectId) { setDocuments([]); return; }
    const q = query(collection(db, 'projects', selectedProjectId, 'documents'), orderBy('createdAt', 'desc'));
    return onSnapshot(q, (snap) => setDocuments(snap.docs.map((d) => ({ id: d.id, projectId: selectedProjectId, ...d.data() }))));
  }, [selectedProjectId]);

  useEffect(() => {
    const unsubs = documents.map((d) => onSnapshot(collection(db, 'projects', d.projectId, 'documents', d.id, 'signatures'), (snap) => {
      setSignaturesByDoc((prev) => ({ ...prev, [d.id]: snap.docs.map((x) => ({ id: x.id, ...x.data() })) }));
    }));
    return () => unsubs.forEach((u) => u());
  }, [documents]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  if (loading) return <main className="shell"><Card>Cargando...</Card></main>;
  if (!user) return <Login />;

  return (
    <main className="shell">
      <header className="topbar">
        <div><h1>GB Sign</h1><p>Gestión de documentos, solicitudes de firma y evidencia electrónica.</p></div>
        <div className="userbox">
          {user.photoURL && <img src={user.photoURL} alt="" />}
          <span>{user.displayName || user.email}</span>
          <Button variant="ghost" onClick={() => signOut(auth)}><LogOut size={16}/> Salir</Button>
        </div>
      </header>

      <section className="grid two">
        <Card>
          <div className="cardHead"><h2>Proyectos</h2><FolderPlus size={22}/></div>
          <CreateProject onCreated={setSelectedProjectId}/>
          <div className="list">
            {projects.map((p) => <button key={p.id} className={`row ${p.id === selectedProjectId ? 'active' : ''}`} onClick={() => setSelectedProjectId(p.id)}>
              <strong>{p.name}</strong><span>{p.client || 'Sin cliente'} · {fmtDate(p.createdAt)}</span>
            </button>)}
            {!projects.length && <Empty title="Sin proyectos">Creá una carpeta de proyecto para empezar.</Empty>}
          </div>
        </Card>

        <Card>
          <div className="cardHead"><h2>Firmas pendientes para mí</h2><FileSignature size={22}/></div>
          <div className="list">
            {pending.map((d) => <PendingDoc key={`${d.projectId}-${d.id}`} docu={d} user={user}/>)}
            {!pending.length && <Empty title="Sin pendientes">Cuando te soliciten una firma con tu mail de Google, aparecerá acá.</Empty>}
          </div>
        </Card>
      </section>

      {selectedProject && <ProjectPanel project={selectedProject} documents={documents} signaturesByDoc={signaturesByDoc} user={user}/>} 
    </main>
  );
}

function Login() {
  return <main className="login"><Card className="loginCard"><ShieldCheck size={46}/><h1>GB Sign</h1><p>Ingresá con Google para ver proyectos, cargar documentos o firmar solicitudes asignadas a tu correo.</p><Button onClick={() => signInWithPopup(auth, provider)}>Ingresar con Google</Button></Card></main>;
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

function ProjectPanel({ project, documents, signaturesByDoc, user }) {
  return <section className="project">
    <div className="sectionTitle"><h2>{project.name}</h2><Badge>{project.client || 'Proyecto interno'}</Badge></div>
    <section className="grid two">
      <Card><div className="cardHead"><h3>Cargar documento y solicitar firmas</h3><Upload size={22}/></div><UploadDocument project={project}/></Card>
      <Card><div className="cardHead"><h3>Colaboradores</h3><Users size={22}/></div><Members project={project} currentUser={user}/></Card>
    </section>
    <Card><h3>Documentos del proyecto</h3><div className="table">
      <div className="tr th"><span>Documento</span><span>Firmantes</span><span>Estado</span><span>Acciones</span></div>
      {documents.map((d) => <DocumentRow key={d.id} docu={d} signatures={signaturesByDoc[d.id] || []}/>) }
    </div>{!documents.length && <Empty title="Sin documentos">Subí un PDF, imagen o documento para solicitar firmas.</Empty>}</Card>
  </section>;
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
      await updateDoc(docRef, { storagePath, updatedAt: serverTimestamp() });
      setTitle(''); setEmails(''); setFile(null);
    } finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={submit}>
    <Field label="Título"><input value={title} onChange={(e)=>setTitle(e.target.value)} placeholder="Ej: Cesión de imagen - Actor"/></Field>
    <Field label="Mails de Google de firmantes" hint="Separados por coma, espacio o salto de línea."><textarea value={emails} onChange={(e)=>setEmails(e.target.value)} placeholder="persona@gmail.com, otra@empresa.com"/></Field>
    <Field label="Archivo"><input type="file" onChange={(e)=>setFile(e.target.files?.[0] || null)}/></Field>
    <Button disabled={busy}>{busy ? 'Subiendo...' : 'Cargar y solicitar firmas'}</Button>
  </form>;
}

function Members({ project, currentUser }) {
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  useEffect(() => onSnapshot(collection(db, 'projects', project.id, 'members'), (snap) => setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() })))), [project.id]);
  async function addMember(e) {
    e.preventDefault();
    const clean = normalizeEmail(email);
    if (!clean) return;
    const pseudoUid = `email_${clean.replace(/[^a-z0-9]/g, '_')}`;
    const nextEmails = [...new Set([...(project.collaboratorEmails || []), clean])];
    await updateDoc(doc(db, 'projects', project.id), { collaboratorEmails: nextEmails, updatedAt: serverTimestamp() });
    await setDoc(doc(db, 'projects', project.id, 'members', pseudoUid), { email: clean, role: 'collaborator', createdAt: serverTimestamp(), invitedBy: normalizeEmail(currentUser.email) });
    setEmail('');
  }
  return <div className="stack"><form className="inlineForm" onSubmit={addMember}><input placeholder="mail del colaborador" value={email} onChange={(e)=>setEmail(e.target.value)}/><Button>Agregar</Button></form><div className="chips">{members.map((m)=><span className="chip" key={m.id}>{m.email} · {m.role}</span>)}</div><small>El acceso se habilita por email de Google. El colaborador debe iniciar sesión con ese mismo correo.</small></div>;
}

function DocumentRow({ docu, signatures }) {
  const [url, setUrl] = useState('');
  const tone = statusFor(docu, signatures) === 'Completo' ? 'good' : 'warn';
  async function openFile() {
    const u = await getDownloadURL(ref(storage, docu.storagePath));
    setUrl(u); window.open(u, '_blank', 'noopener,noreferrer');
  }
  function evidence() {
    const payload = { document: docu, signatures };
    downloadText(`evidencia-${docu.title}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }
  return <div className="tr"><span><strong>{docu.title}</strong><small>{docu.fileName}<br/>SHA-256: {docu.sha256}</small></span><span>{(docu.signerEmails || []).map((e)=><small key={e}>{e}</small>)}</span><span><Badge tone={tone}>{statusFor(docu, signatures)}</Badge></span><span className="actions"><Button variant="ghost" onClick={openFile}><Download size={16}/> Ver</Button><Button variant="ghost" onClick={evidence}>Evidencia</Button>{url && <a href={url}>link</a>}</span></div>;
}

function PendingDoc({ docu, user }) {
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => onSnapshot(doc(db, 'projects', docu.projectId, 'documents', docu.id, 'signatures', user.uid), (snap) => setSigned(snap.exists())), [docu.projectId, docu.id, user.uid]);
  async function view() { window.open(await getDownloadURL(ref(storage, docu.storagePath)), '_blank', 'noopener,noreferrer'); }
  async function sign() {
    setBusy(true);
    try {
      await setDoc(doc(db, 'projects', docu.projectId, 'documents', docu.id, 'signatures', user.uid), {
        uid: user.uid,
        email: normalizeEmail(user.email),
        displayName: user.displayName || '',
        documentSha256: docu.sha256,
        acceptedText: 'Declaro que revisé el documento indicado y acepto firmarlo electrónicamente con mi cuenta Google autenticada.',
        userAgent: navigator.userAgent,
        signedAt: serverTimestamp(),
      });
    } finally { setBusy(false); }
  }
  return <div className="pending"><div><strong>{docu.title}</strong><small>{docu.fileName}<br/>Hash: {docu.sha256}</small></div><div className="actions"><Button variant="ghost" onClick={view}>Ver</Button>{signed ? <Badge tone="good"><CheckCircle2 size={14}/> Firmado</Badge> : <Button onClick={sign} disabled={busy}>{busy ? 'Firmando...' : 'Firmar'}</Button>}</div></div>;
}

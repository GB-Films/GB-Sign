import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

const projectId = 'demo-gb-sign-access';
assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(localhost|127\.0\.0\.1):\d+$/);
assert.match(process.env.FIREBASE_STORAGE_EMULATOR_HOST || '', /^(localhost|127\.0\.0\.1):\d+$/);
const env = await initializeTestEnvironment({
  projectId, firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  storage: { rules: readFileSync('storage.rules', 'utf8') },
});
const email = name => `${name}@example.test`;
const user = name => env.authenticatedContext(name, { email: email(name), email_verified: true });
const owner = user('owner'), first = user('first'), second = user('second'), outsider = user('outsider');
const firstFields = [{ id: 'a', signerEmail: email('first'), page: 1 }];
const secondFields = [{ id: 'b', signerEmail: email('second'), page: 1 }];
const signers = [email('first'), email('second')];
const documentPath = 'projects/native/documents/contract';
const requestId = name => `native_contract_${name}_example_test`;
const requestRef = (db, name) => doc(db, 'signatureRequests', requestId(name));
const originalPath = `${documentPath}/original.pdf`;
const artifactsPath = 'projects/native/artifacts/contract/final/signed.pdf';
const bucket = `gs://${projectId}.appspot.com`;
const bytes = new Uint8Array([37, 80, 68, 70]);
const sha256 = 'a'.repeat(64);
const requestData = (name, signatureFields) => ({
  projectId: 'native', projectName: 'Prueba', projectClient: '', docId: 'contract',
  title: 'Documento ficticio', fileName: 'original.pdf', contentType: 'application/pdf',
  storagePath: originalPath, sha256, signerEmail: email(name), allSignerEmails: signers, signatureFields, status: 'pending',
  requestedByUid: 'owner', requestedByEmail: email('owner'), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
});
try {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'projects/native'), { ownerUid: 'owner', collaboratorEmails: [] });
    await setDoc(doc(db, documentPath), { sha256, signerEmails: signers, signatureFields: [...firstFields, ...secondFields] });
    await uploadBytes(ref(ctx.storage(bucket), originalPath), bytes, { contentType: 'application/pdf' });
  });
  const ownerDb = owner.firestore();
  const batch = writeBatch(ownerDb);
  batch.update(doc(ownerDb, documentPath), { storagePath: originalPath });
  batch.set(requestRef(ownerDb, 'first'), requestData('first', firstFields));
  batch.set(requestRef(ownerDb, 'second'), requestData('second', secondFields));
  await assertSucceeds(batch.commit());

  for (const [signer, name] of [[first, 'first'], [second, 'second']]) {
    const db = signer.firestore();
    const own = await assertSucceeds(getDocs(query(collection(db, 'signatureRequests'), where('signerEmail', '==', email(name)))));
    assert.deepEqual(own.docs.map(row => row.id), [requestId(name)]);
    assert.equal((await assertSucceeds(getDoc(doc(db, documentPath)))).exists(), true);
    assert.deepEqual(new Uint8Array(await assertSucceeds(getBytes(ref(signer.storage(bucket), originalPath)))), bytes);
  }
  await assertFails(getDoc(doc(outsider.firestore(), documentPath)));
  await assertFails(getBytes(ref(outsider.storage(bucket), originalPath)));
  await assertFails(getDoc(requestRef(first.firestore(), 'second')));

  const revised = [{ ...firstFields[0], page: 2 }];
  const change = writeBatch(ownerDb);
  change.update(doc(ownerDb, documentPath), { signatureFields: [...revised, ...secondFields] });
  change.update(requestRef(ownerDb, 'first'), { signatureFields: revised, updatedAt: serverTimestamp() });
  await assertSucceeds(change.commit());

  // The signing service alone controls pending-to-signed state and artifacts.
  await env.withSecurityRulesDisabled(async ctx => {
    await updateDoc(doc(ctx.firestore(), documentPath), { signatureLocked: true, status: 'completed',
      signatureStatus: signers.map(email => ({ email, status: 'signed' })),
      serverArtifacts: { signedPdfPath: artifactsPath } });
    for (const name of ['first', 'second']) await updateDoc(requestRef(ctx.firestore(), name), { status: 'signed' });
    await uploadBytes(ref(ctx.storage(bucket), artifactsPath), bytes, { contentType: 'application/pdf' });
  });
  for (const [signer, name] of [[first, 'first'], [second, 'second']]) {
    const own = await assertSucceeds(getDoc(requestRef(signer.firestore(), name)));
    assert.equal(own.data().status, 'signed');
    assert.deepEqual(new Uint8Array(await assertSucceeds(getBytes(ref(signer.storage(bucket), artifactsPath)))), bytes);
  }
  await assertFails(getBytes(ref(outsider.storage(bucket), artifactsPath)));
  await assertFails(updateDoc(requestRef(ownerDb, 'first'), { signatureFields: firstFields, updatedAt: serverTimestamp() }));
  console.log('PASS assigned requests, original PDFs, signed states and authorized output downloads');
} finally {
  await env.cleanup();
}

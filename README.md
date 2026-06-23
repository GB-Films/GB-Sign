# GB Sign

App web de firma electrónica para **GB Films / Gran Berta**, publicada en **GitHub Pages** y usando **Firebase** como backend.

Repositorio:

```txt
https://github.com/GB-Films/GB-Sign
```

URL pública:

```txt
https://gb-films.github.io/GB-Sign/
```

## Firebase configurado

Proyecto Firebase:

```txt
gb-sign-e1776
```

Bucket Storage:

```txt
gs://gb-sign-e1776.firebasestorage.app
```

Variables cargadas:

```env
VITE_FIREBASE_API_KEY=AIzaSyArlGUrcJjYQn1MXfamb1BDWJy-n_-W6aU
VITE_FIREBASE_AUTH_DOMAIN=gb-sign-e1776.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=gb-sign-e1776
VITE_FIREBASE_STORAGE_BUCKET=gb-sign-e1776.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=954032772128
VITE_FIREBASE_APP_ID=1:954032772128:web:040343030879c447329845
VITE_APP_BASE=/GB-Sign/
```

## Roles corregidos

La app separa tres perfiles:

### Administrador interno

Puede:

- Crear proyectos.
- Ver los proyectos propios.
- Cargar documentos.
- Solicitar firmas.
- Agregar colaboradores internos.
- Descargar documentos y evidencias.

Para que un usuario sea administrador hay que crear manualmente este documento en Firestore:

```txt
admins/{UID_DEL_USUARIO}
```

Ejemplo de datos del documento:

```json
{
  "email": "tu-mail@gmail.com",
  "role": "admin",
  "createdAt": "manual"
}
```

El UID aparece dentro de la app cuando el usuario entra sin permisos internos.

### Colaborador interno

Se agrega desde **Configuración** dentro de un proyecto, en la sección **Colaboradores internos**.

Puede:

- Ver ese proyecto.
- Cargar documentos.
- Descargar documentos.
- Solicitar firmas dentro de ese proyecto.

No puede crear proyectos nuevos, salvo que también sea administrador.

### Firmante externo

Se carga únicamente en el campo **Mails de Google de firmantes externos** al subir un documento.

Puede:

- Entrar con Google.
- Ver solo los documentos asociados exactamente a su email.
- Abrir el archivo asignado.
- Firmar electrónicamente.

No puede:

- Crear proyectos.
- Ver proyectos internos.
- Subir documentos.
- Ver documentos de otros firmantes.
- Ver carpetas de trabajo.

## Primer setup obligatorio

Después de loguearte por primera vez con tu cuenta interna:

1. Entrá a la app.
2. Copiá tu UID desde el cartel de acceso limitado.
3. En Firebase Console abrí:

```txt
Firestore Database > Data
```

4. Creá la colección:

```txt
admins
```

5. Creá un documento cuyo ID sea tu UID.
6. Cargá algo así:

```json
{
  "email": "tu-mail@gmail.com",
  "role": "admin"
}
```

7. Recargá la app con `Ctrl + F5`.

A partir de ahí vas a poder crear proyectos.

## Qué hace

- Login con Google mediante Firebase Authentication.
- Carpetas de proyectos.
- Colaboradores internos por email de Google, dentro del panel **Configuración** del proyecto.
- Carga de documentos en Firebase Storage.
- Solicitud de firma a firmantes externos por mail de Google.
- Panel de documentos asignados para cada firmante.
- Recuadros de firma configurables por el administrador sobre el documento.
- Firma con mouse/touch o firma cursiva generada con el nombre del firmante.
- Firma electrónica con evidencia técnica.
- Registro de UID, email, nombre, fecha, user agent, texto de aceptación, hash SHA-256, campo de firma, coordenadas del campo y trazo/nombre aplicado.
- Descarga/verificación de evidencia en JSON.

> Importante: esto implementa firma electrónica con evidencia técnica. No reemplaza una firma digital certificada con certificado emitido por autoridad certificante.


## Firma visual y formalidad

La firma no se guarda como un botón genérico. El administrador debe asignar un campo de firma para cada firmante. Para marcarlo, elegí el firmante y arrastrá sobre la vista previa del documento; la app coloca una capa transparente por encima del PDF/imagen para que el recuadro se pueda dibujar sin que el visor del navegador capture el mouse. Cada campo queda registrado con:

- Email del firmante.
- Página declarada.
- Coordenadas relativas `x`, `y`, `w`, `h`.
- Identificador del campo.

Cuando el firmante entra, debe presionar su campo asignado y elegir una de dos opciones:

- Dibujar la firma con mouse o touch.
- Usar una firma cursiva generada con su nombre.

La evidencia guardada incluye el campo usado, el trazo o nombre aplicado, consentimiento electrónico, UID de Firebase Auth, email autenticado por Google, hash SHA-256 del documento, user agent y fecha de firma.

## Stack

- React + Vite
- Firebase Auth
- Cloud Firestore
- Firebase Storage
- GitHub Pages con GitHub Actions

## Instalación local

Desde la carpeta del repo:

```bash
npm install
npm run dev
```

Abrir la URL local que muestre Vite, normalmente:

```txt
http://localhost:5173
```

## Deploy en GitHub Pages

1. Subir los archivos a `GB-Films/GB-Sign`.
2. Entrar en GitHub:

```txt
Settings > Pages
```

3. En **Build and deployment**, elegir:

```txt
Source: GitHub Actions
```

4. Hacer push a `main`.
5. Esperar que termine el workflow **Deploy to GitHub Pages**.

La app queda publicada en:

```txt
https://gb-films.github.io/GB-Sign/
```

## Reglas Firebase

Ya están incluidas:

```txt
firestore.rules
storage.rules
firebase.json
.firebaserc
```

Para subirlas desde terminal:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,storage
```

También podés pegarlas manualmente desde la consola:

- `firestore.rules` en Firestore Database > Rules.
- `storage.rules` en Storage > Rules.

## Dominios autorizados necesarios

En Firebase:

```txt
Authentication > Settings > Authorized domains
```

Verificar que estén:

```txt
localhost
gb-films.github.io
```

No agregar `/GB-Sign/`, porque Firebase pide dominio, no ruta.

## Modelo de datos

```txt
admins/{uid}
users/{uid}
projects/{projectId}
projects/{projectId}/members/{memberId}
projects/{projectId}/documents/{docId}
projects/{projectId}/documents/{docId}/signatures/{uid}
signatureRequests/{projectId_docId_emailKey}
Campo nuevo: documents/{docId}.signatureFields[]
Storage: projects/{projectId}/documents/{docId}/{fileName}
```

`signatureRequests` es la colección que alimenta el panel de firmantes externos. Esto evita que un firmante tenga que ver el proyecto completo.

## Flujo de uso

1. Un administrador interno crea el proyecto.
2. Agrega colaboradores internos si hace falta.
3. Carga un documento.
4. Escribe los emails de Google de los firmantes externos.
5. Marca un recuadro de firma para cada firmante sobre el documento.
6. La app sube el archivo a Firebase Storage.
7. La app calcula el hash SHA-256 localmente.
8. La app crea una solicitud individual en `signatureRequests` para cada firmante, incluyendo el campo de firma asignado.
9. El firmante entra con Google usando exactamente ese email.
10. Ve el documento en **Documentos para firmar**.
11. Abre el documento, presiona su recuadro de firma, dibuja la firma o usa el nombre cursivo y acepta el consentimiento.
12. La app guarda evidencia en Firestore.
13. Desde el documento se puede descargar el JSON de evidencia.

## Limitaciones importantes

- GitHub Pages no ejecuta backend. Por eso el sistema depende del frontend y de las reglas Firebase.
- No hay envío automático de emails. Por ahora la solicitud queda visible cuando el firmante entra con su Google.
- La IP pública del firmante no se registra porque desde frontend puro no es confiable.
- Para hacerlo más fuerte legal/técnicamente, conviene sumar Cloud Functions para sellado de tiempo, IP confiable, envío automático de emails y certificado PDF.

## Próximas mejoras recomendadas

- Link directo de firma por documento.
- Cloud Function para invitaciones por email.
- Cloud Function para resolver colaboradores por email a UID.
- Sellado de tiempo desde servidor.
- Certificado PDF automático con evidencia.
- Estampado real de la firma sobre una copia PDF final desde Cloud Functions.
- App Check para reducir abuso desde dominios no autorizados.
- Panel de auditoría por proyecto.

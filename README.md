# GB Sign Firebase

App web de firma electrónica para GitHub Pages + Firebase.

## Qué hace

- Login con Google mediante Firebase Authentication.
- Carpetas de proyectos.
- Carga de documentos en Firebase Storage.
- Solicitud de firma a firmantes por mail de Google.
- Panel de firmas pendientes para cada usuario autenticado.
- Registro de firma con UID, email, nombre, fecha, user agent, texto de aceptación y hash SHA-256 del archivo.
- Descarga/verificación de evidencia en JSON.
- Colaboradores por proyecto para ver, cargar y descargar documentos.

> Importante: esto implementa firma electrónica con evidencia técnica. No reemplaza una firma digital certificada con certificado emitido por autoridad certificante.

## Stack

- React + Vite
- Firebase Auth
- Cloud Firestore
- Firebase Storage
- GitHub Pages con GitHub Actions

## Crear proyecto Firebase

1. Entrar a Firebase Console y crear un proyecto.
2. Crear una Web App y copiar la configuración.
3. Activar Authentication > Sign-in method > Google.
4. Activar Cloud Firestore.
5. Activar Storage.
6. En Authentication > Settings > Authorized domains, agregar:
   - `localhost`
   - `TU_USUARIO.github.io`
   - tu dominio propio, si corresponde.

## Configuración local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Completar `.env.local`:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_APP_BASE=/nombre-del-repo/
```

Si publicás en un dominio raíz o custom domain, `VITE_APP_BASE=/`.
Si publicás en `https://usuario.github.io/gb-sign-firebase/`, usar `VITE_APP_BASE=/gb-sign-firebase/`.

## Reglas Firebase

Instalar Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
npm run deploy:rules
```

También podés copiar manualmente:

- `firestore.rules` en Firestore > Rules.
- `storage.rules` en Storage > Rules.

## Deploy en GitHub Pages

1. Subir el repo a GitHub.
2. En Settings > Pages, elegir Source: GitHub Actions.
3. En Settings > Secrets and variables > Actions, crear estos secrets:

```bash
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_APP_BASE
```

4. Hacer push a `main`.

## Modelo de datos

```txt
users/{uid}
projects/{projectId}
projects/{projectId}/members/{uid}
projects/{projectId}/documents/{docId}
projects/{projectId}/documents/{docId}/signatures/{uid}
Storage: projects/{projectId}/documents/{docId}/{fileName}
```

## Flujo de firma

1. Un colaborador carga un documento y lista mails de firmantes.
2. El archivo se sube a Storage.
3. La app calcula SHA-256 localmente y lo guarda en Firestore.
4. El firmante ingresa con Google.
5. Si el email autenticado coincide con `signerEmails`, ve el documento pendiente.
6. Al firmar, se crea un registro inmutable en `signatures/{uid}`.
7. Desde el documento se puede bajar un JSON de evidencia.

## Limitaciones importantes

- GitHub Pages no ejecuta backend. Por eso el sistema depende de reglas Firebase y del cliente.
- No hay envío automático de emails. Para eso conviene agregar Cloud Functions, SendGrid/Mailgun o Firebase Extensions.
- La IP pública del firmante no se registra porque desde frontend puro no es confiable. Con Cloud Functions se puede agregar.
- El agregado de colaboradores por email queda como invitación interna. Para permisos más estrictos por UID, el colaborador debe iniciar sesión y el owner debe registrar su UID. Esto puede automatizarse con Cloud Functions.

## Próximas mejoras recomendadas

- Cloud Function para invitaciones por email.
- Cloud Function para resolver colaboradores por email a UID.
- Sellado de tiempo desde servidor.
- Certificado PDF automático con evidencia.
- App Check para reducir abuso desde dominios no autorizados.
- Panel de auditoría por proyecto.

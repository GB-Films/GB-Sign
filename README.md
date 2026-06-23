# GB Sign

App web de firma electrónica para **GB Films / Gran Berta**, lista para publicar en **GitHub Pages** y usar **Firebase** como backend.

Repositorio previsto:

```txt
https://github.com/GB-Films/GB-Sign
```

URL prevista de GitHub Pages:

```txt
https://gb-films.github.io/GB-Sign/
```

## Firebase configurado

Proyecto Firebase:

```txt
gb-sign-e1776
```

App web:

```txt
GB Sign
```

Bucket Storage:

```txt
gs://gb-sign-e1776.firebasestorage.app
```

Variables ya cargadas en el repo:

```env
VITE_FIREBASE_API_KEY=AIzaSyArlGUrcJjYQn1MXfamb1BDWJy-n_-W6aU
VITE_FIREBASE_AUTH_DOMAIN=gb-sign-e1776.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=gb-sign-e1776
VITE_FIREBASE_STORAGE_BUCKET=gb-sign-e1776.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=954032772128
VITE_FIREBASE_APP_ID=1:954032772128:web:040343030879c447329845
VITE_APP_BASE=/GB-Sign/
```

Están en:

```txt
.env.example
.env.local
.env.production
```

`.env.production` queda pensado para que GitHub Actions pueda compilar sin tener que cargar variables manualmente en GitHub.

## Qué hace

- Login con Google mediante Firebase Authentication.
- Carpetas de proyectos.
- Colaboradores por email de Google.
- Carga de documentos en Firebase Storage.
- Solicitud de firma a firmantes por mail de Google.
- Panel de firmas pendientes para cada usuario autenticado.
- Firma electrónica con evidencia técnica.
- Registro de UID, email, nombre, fecha, user agent, texto de aceptación y hash SHA-256 del archivo.
- Descarga/verificación de evidencia en JSON.

> Importante: esto implementa firma electrónica con evidencia técnica. No reemplaza una firma digital certificada con certificado emitido por autoridad certificante.

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

La app debería quedar publicada en:

```txt
https://gb-films.github.io/GB-Sign/
```

## Comandos para pushear

Si ya estás dentro de la carpeta del repo:

```bash
git add .
git commit -m "Configure GB Sign Firebase app"
git push origin main
```

Si te vuelve a aparecer error porque el remoto tiene cambios:

```bash
git pull origin main --allow-unrelated-histories
git push origin main
```

## Reglas Firebase

Ya están incluidas:

```txt
firestore.rules
storage.rules
firebase.json
.firebaserc
```

Para subirlas desde la terminal:

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
users/{uid}
projects/{projectId}
projects/{projectId}/members/{uid}
projects/{projectId}/documents/{docId}
projects/{projectId}/documents/{docId}/signatures/{uid}
Storage: projects/{projectId}/documents/{docId}/{fileName}
```

## Flujo de uso

1. El usuario entra con Google.
2. Crea una carpeta/proyecto.
3. Agrega colaboradores por email.
4. Carga un documento.
5. Escribe los emails de Google de los firmantes.
6. El archivo se sube a Firebase Storage.
7. La app calcula el hash SHA-256 localmente.
8. El firmante entra con Google usando el mismo email solicitado.
9. Ve el documento en “Firmas pendientes para mí”.
10. Revisa el archivo y firma.
11. La app guarda evidencia en Firestore.
12. Desde el documento se puede descargar el JSON de evidencia.

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
- App Check para reducir abuso desde dominios no autorizados.
- Panel de auditoría por proyecto.

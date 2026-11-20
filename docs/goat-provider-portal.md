# Integración con el portal GOAT

Esta rama conserva el acceso exclusivamente con Google, la verificación de correo y el intercambio de una sesión autenticada de GOAT. La aplicación no registra una contraseña propia. No configura proveedores de identidad, IAM ni usuarios reales al publicar código.

`exchangeGoatSession` verifica el ID token y su revocación contra `gb-goat`, exige correo verificado y método Google, y consulta `providerPortalConfig/current.enabled`. Reutiliza una cuenta de Sign por correo, rechaza cuentas deshabilitadas y emite una sesión temporal de Sign con la identidad Google de origen. No escribe `admins` ni concede permisos de proyectos. La aplicación GOAT usa esa sesión sólo en memoria para llamar al motor de firma.

GOAT conserva sus proveedores, representaciones y aprobaciones. Sign conserva los PDFs, campos asignados, evidencia y artefactos de firma. Los UIDs de los dos proyectos se mantienen separados; `goatActorUid` identifica el origen cuando corresponde. Una coincidencia de nombre no concede acceso.

Las declaraciones tienen `portalManaged:true`, hash de contenido y referencia al proveedor/operación GOAT. Sus originales y datos no se pueden modificar desde el SDK. El motor exige el consentimiento explícito conocido y verifica el SHA256 antes de crear evidencia. Tras una firma se congela el documento; las regeneraciones guardan nuevas rutas de artefactos y comprueban las firmas vigentes en transacción. No se borran documentos firmados mediante el borrado en cascada del administrador.

El motor acepta la sesión directa de Google o una sesión de servidor del puente GOAT que conserve esa identidad Google verificada. Otros métodos se rechazan, aunque intenten declarar Google en un campo ajeno al método real. El certificado conserva la identidad usada. La firma sigue siendo electrónica con evidencia, sin certificación de DNI o facultad de representación. Un archivo no PDF debe convertirse antes de usar la generación de PDF firmado.

Activación coordinada: consultar `docs/provider-portal.md` del cambio compatible en GOAT. La función de intercambio usa el parámetro `SIGN_GOAT_BRIDGE_SERVICE_ACCOUNT`, cuyo valor por defecto es `sign-goat-bridge@gb-sign-e1776.iam.gserviceaccount.com`; esa identidad debe aprovisionarse antes de desplegar. Requiere Google habilitado en ambos proyectos, permisos del servicio Sign para verificar/reconsultar identidad GOAT y leer la habilitación, y firma de custom tokens mediante su identidad de ejecución. Los servicios GOAT necesitan las operaciones de datos/archivos Sign que utiliza el puente; esa delegación de infraestructura requiere revisión expresa. Las cuentas de servicio son necesarias también para Google. Ninguna clave privada se distribuye al navegador.

Pruebas locales:

```text
npm ci --prefix functions
npm test --prefix functions
npm run build
```

La prueba conjunta en GOAT ejecuta en emuladores el motor de esta rama con PDFs reales y verifica que los datos comunes se apliquen y los críticos queden en revisión. El contexto de producción y el consentimiento OAuth real deben comprobarse por separado antes de habilitar usuarios.
# Acceso a solicitudes y PDFs en GBSign

En Mis firmas, cada cuenta Google verificada consulta las solicitudes de su correo. Al abrir una, GBSign escucha el documento para mostrar el estado actual. La firma se registra en el servidor, que comprueba el correo asignado, el documento, el recuadro y la versión del PDF.

Una solicitud nativa nueva se registra junto con la referencia al original. Una vez creada, su asignación se conserva. El equipo del proyecto puede corregir recuadros de una solicitud pendiente. El estado de firma y la evidencia se escriben desde el servidor. Las solicitudes de GOAT siguen a cargo de la integración.

El PDF firmado se descarga con la sesión de la cuenta. En el celular y la computadora, abrir una firma ya registrada muestra el estado y las descargas disponibles. Si existe un PDF final, se reutiliza. Los enlaces de firma abren la solicitud y requieren la cuenta asignada.

Para publicar los cambios, verificar primero el flujo de la nueva web con cuentas de prueba. Después publicar las reglas de Firestore y la revisión de la función de firma, y comprobar la creación, el ajuste de recuadros pendientes y la descarga autenticada.

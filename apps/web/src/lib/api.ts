import { environment } from '../config/environment';

export type ApiErrorResponse = {
  message?: string;
  code?: string;
  details?: unknown;
};

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function getApiFieldErrors<T extends string>(error: unknown, fieldMap: Record<string, T>): Partial<Record<T, string>> {
  if (!(error instanceof ApiRequestError) || error.code !== 'VALIDATION_ERROR' || !Array.isArray(error.details)) return {};
  const fieldErrors: Partial<Record<T, string>> = {};
  for (const issue of error.details) {
    if (typeof issue !== 'object' || issue === null || !('path' in issue) || !Array.isArray(issue.path)) continue;
    const field = issue.path[0];
    if (typeof field !== 'string') continue;
    const target = fieldMap[field];
    if (target) fieldErrors[target] = 'Revisa este campo.';
  }
  return fieldErrors;
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  switch (error.code) {
    case 'NETWORK_ERROR': return 'No se pudo confirmar la operación porque se perdió la conexión. Revisa la conexión y actualiza la información antes de volver a intentarlo.';
    case 'INVALID_RESPONSE': return 'El servicio devolvió una respuesta inesperada. Actualiza la información antes de volver a intentarlo.';
    case 'INVALID_CREDENTIALS': return 'El usuario, correo o contraseña no son correctos.';
    case 'CONFLICT': return 'Ya existe un registro con esos datos.';
    case 'VALIDATION_ERROR': return 'Revisa los datos ingresados.';
    case 'IMPORT_REVIEW_NOT_READY': return 'La revisión de importaciones todavía no está habilitada en el servidor. El responsable debe completar el despliegue y las migraciones antes de continuar.';
    case 'INVALID_HISTORICAL_TARGET': return 'Selecciona una observación física reconocida por la consulta de evidencia histórica.';
    case 'INVALID_HISTORICAL_EVIDENCE': return 'La evidencia guardada no puede interpretarse con seguridad. Solicita una revisión del servidor; no reemplaces su origen.';
    case 'HISTORICAL_PLAN_LIMIT': return 'La historia o las revisiones exceden el límite de planificación. Solicita una revisión; no se prepara una historia parcial.';
    case 'HISTORICAL_PLAN_CHANGED': return 'El plan histórico cambió. Actualiza la evidencia, genera otro plan y confirma nuevamente antes de aplicar.';
    case 'HISTORICAL_PLAN_BLOCKED': return 'El periodo tiene bloqueos vigentes. Genera un plan actualizado y revisa las incidencias antes de aplicar.';
    case 'HISTORICAL_EVIDENCE_ALREADY_APPLIED': return 'Una evidencia ya pertenece a historia aplicada. Consulta los comprobantes del activo; no la uses para otro periodo.';
    case 'HISTORICAL_APPLICATION_BUSY': return 'La aplicación histórica está ocupada. Recupera exactamente la misma intención y clave.';
    case 'HISTORICAL_APPLICATION_CONFLICT': return 'Hay un conflicto con una aplicación existente. Recupera el mismo intento y consulta los comprobantes; no generes una clave duplicada.';
    case 'CLOSED_APPLICATION_LIST_CHANGED': return 'Cambió el total de comprobantes al consultar las páginas. Conservamos las filas; actualiza los periodos desde el inicio.';
    case 'HISTORY_PREVIEW_CHANGED': return 'La evidencia histórica cambió. Actualiza la consulta y revisa la selección antes de guardarla.';
    case 'HISTORY_ASSET_LINK_UNCONFIRMED': return 'El vínculo con el activo no está confirmado. Actualiza la evidencia y elige un vínculo autorizado o guarda expresamente sin vincular.';
    case 'HISTORY_EVIDENCE_ALREADY_CAPTURED': return 'Esta observación ya fue capturada, posiblemente desde otro lote del mismo archivo. Consulta su comprobante; no la captures nuevamente.';
    case 'HISTORY_CAPTURE_CONFLICT': return 'La captura coincide con una solicitud o evidencia existente. Recupera primero la misma intención y consulta los comprobantes; no generes otra clave.';
    case 'HISTORY_CAPTURE_BUSY': return 'La captura está ocupada. Reintenta recuperar con la misma intención y clave.';
    case 'HISTORY_SOURCE_LIMIT': return 'La evidencia supera el límite de revisión admitido por el servidor. Solicita una revisión del proceso; no recortes el origen para forzar la captura.';
    case 'HISTORY_LIST_CHANGED': return 'Se añadieron capturas mientras consultabas las páginas. Las filas cargadas se conservan; actualiza los comprobantes desde el inicio para continuar.';
    case 'EVIDENCE_HISTORY_CHANGED': return 'La versión vigente cambió entre páginas. Se conserva la consulta anterior; consulta las versiones desde el inicio.';
    case 'EVIDENCE_VERSION_CONFLICT': return 'Otra revisión cambió esta evidencia. Consulta lo vigente, genera otra propuesta y vuelve a confirmar.';
    case 'EVIDENCE_ALREADY_APPLIED': return 'Esta evidencia ya fue usada en historia aplicada. No se puede enmendar por este flujo.';
    case 'EVIDENCE_AMENDMENT_PLAN_CHANGED': return 'La propuesta documental ya no coincide con el servidor. Revisa y genera una nueva antes de confirmar.';
    case 'EVIDENCE_AMENDMENT_BLOCKED': return 'El servidor bloqueó la enmienda. Genera una propuesta nueva para revisar las causas; no se guardó por este intento.';
    case 'EVIDENCE_AMENDMENT_BUSY':
    case 'EVIDENCE_AMENDMENT_CONFLICT': return 'No se pudo confirmar el resultado documental. Recupera el mismo intento antes de preparar otro.';
    case 'SOURCE_REVISION_CONFLICT': return 'Cambió la interpretación del origen. Actualiza su revisión antes de continuar; los planes anteriores deben volver a evaluarse.';
    case 'INVALID_SOURCE_TARGET': return 'Selecciona un equipo físico y una fila reconocida del lote original.';
    case 'INVALID_SOURCE_FIELD': return 'Ese campo no está reconocido en la hoja seleccionada. Revisa la evidencia; no añadas columnas por inferencia.';
    case 'FUTURE_SOURCE_CORRECTION': return 'La fecha de recepción verificada no puede ser futura.';
    case 'SOURCE_CORRECTION_LIMIT': return 'La revisión supera los límites del origen. Revisa hasta 25 cambios por solicitud.';
    case 'SOURCE_FIELD_UNCHANGED': return 'Los valores indicados ya coinciden con el origen vigente. Revisa o quita los cambios sin efecto.';
    case 'SOURCE_TARGET_ALREADY_APPLIED': return 'Este equipo del archivo ya fue aplicado, incluso desde otro lote. Su origen no puede reinterpretarse; utiliza las correcciones operativas.';
    case 'INVALID_SOURCE_REVISION': return 'No se pudo interpretar el historial de correcciones. Solicita revisión del servidor; no reemplaces el archivo original.';
    case 'SOURCE_REVISION_LIMIT': return 'El lote alcanzó el límite de revisiones de origen. Solicita una revisión del proceso antes de continuar.';
    case 'IDENTITY_CANNOT_DROP_SOURCE_VALUE': return 'No se puede eliminar una identidad presente o incierta. Verifica la serie y el activo fijo sin descartar evidencia.';
    case 'IDENTITY_REVIEW_SCOPE_LIMIT': return 'Este equipo supera las 12 observaciones permitidas para verificar identidad. Solicita revisión del origen.';
    case 'IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW': return 'La identidad propuesta dividiría o uniría equipos del archivo. Revisa el origen; no se permite forzar la agrupación.';
    case 'IDENTITY_GROUP_COVERAGE_REQUIRED': return 'Cada fila de los candidatos seleccionados debe pertenecer exactamente a un grupo. Revisa el reparto completo.';
    case 'IDENTITY_GROUP_SCOPE_LIMIT': return 'El alcance supera 25 observaciones completas. Replantea los candidatos; no recortes filas de un candidato.';
    case 'IDENTITY_GROUP_EVIDENCE_LIMIT': return 'La evidencia vinculada supera el límite de revisión. Solicita una revisión administrativa; no se presenta un resultado parcial.';
    case 'IDENTITY_GROUP_SOURCE_RESERVED': return 'Estas filas pertenecen a una revisión de agrupaciones activa. Consulta esa revisión antes de preparar otra propuesta.';
    case 'IDENTITY_GROUP_SOURCE_ALREADY_APPLIED': return 'Estas filas ya fueron utilizadas por un flujo de grupos. Consulta sus comprobantes; no las reinterpretes con este plan.';
    case 'IDENTITY_GROUP_PLAN_CHANGED': return 'El escenario de agrupación cambió. Actualiza el contexto, genera otro escenario y vuelve a revisar antes de reservar.';
    case 'IDENTITY_GROUP_PLAN_BLOCKED': return 'El escenario tiene bloqueos. Genera uno actualizado y revisa todas sus incidencias antes de reservar.';
    case 'IDENTITY_GROUP_ALREADY_RELEASED': return 'Esta reserva ya fue cancelada. Consulta su comprobante; la cancelación no se puede reescribir ni reactivar.';
    case 'INVALID_IDENTITY_GROUP_REVIEW': return 'No se pudo validar la procedencia de esta revisión. Consulta el comprobante guardado y solicita una revisión administrativa.';
    case 'IDENTITY_GROUP_REVIEW_BUSY':
    case 'IDENTITY_GROUP_REVIEW_CONFLICT': return 'No se pudo confirmar la revisión. Recupera exactamente el mismo intento o consulta el comprobante antes de preparar otro.';
    case 'IDENTITY_GROUP_REVIEW_LIST_CHANGED': return 'Cambió el total de revisiones entre páginas. Se conserva la consulta anterior; actualiza desde el inicio para continuar.';
    case 'INVALID_IDENTITY_GROUP_TARGET': return 'El grupo no pertenece a esta revisión. Consulta nuevamente sus grupos antes de decidir.';
    case 'IDENTITY_GROUP_DECISION_VERSION_CONFLICT': return 'Otra decisión cambió la versión global de esta revisión. Actualiza el contexto y vuelve a confirmar.';
    case 'IDENTITY_GROUP_PROJECTION_CHANGED': return 'Cambió el origen, la evidencia o el inventario consultado. Actualiza el contexto y revisa nuevamente la decisión.';
    case 'IDENTITY_GROUP_DECISION_BLOCKED': return 'La proyección tiene conflictos que impiden esta propuesta. Revisa los bloqueos del grupo.';
    case 'IDENTITY_GROUP_ASSET_ALREADY_PROPOSED': return 'Otra decisión de esta revisión ya propone este activo. Consulta las últimas decisiones antes de continuar.';
    case 'IDENTITY_GROUP_EVIDENCE_COVERAGE_REQUIRED': return 'Revisa explícitamente todas las evidencias del grupo, con su motivo y respaldo.';
    case 'IDENTITY_GROUP_DECISION_LIST_CHANGED': return 'La revisión o sus decisiones cambiaron entre páginas. Actualiza desde el inicio para continuar.';
    case 'IDENTITY_CROSS_CANDIDATE_CONFLICT': return 'La identidad coincide con otro equipo del mismo archivo. Revisa ambos antes de continuar.';
    case 'IMPORT_PLAN_CHANGED': return 'El plan cambió desde la evaluación. Revisa el contexto, genera otro plan y confirma de nuevo; no se aplicó esta intención.';
    case 'IMPORT_PLAN_BLOCKED': return 'La selección tiene bloqueos. Genera un plan actualizado y revisa las incidencias antes de continuar.';
    case 'IMPORT_APPLY_BUSY': return 'El inventario está ocupado. Recupera la aplicación con la misma intención y clave; no prepares una solicitud duplicada.';
    case 'IMPORT_TARGET_ALREADY_APPLIED': return 'Un equipo de este archivo ya fue aplicado, posiblemente desde otro lote. Consulta el comprobante original antes de continuar.';
    case 'IMPORT_APPLICATION_CONFLICT': return 'La aplicación entra en conflicto con un resultado existente. Consulta los comprobantes y revisa un plan actualizado.';
    case 'REVIEW_VERSION_CONFLICT': return 'Otro revisor cambió el lote. Actualiza la revisión y comprueba la decisión vigente antes de continuar.';
    case 'BATCH_SNAPSHOT_STALE': return 'Cambió el inventario o las reglas del análisis. Conserva este lote como evidencia y genera uno vigente antes de vincular o proponer equipos.';
    case 'INVALID_REVIEW_TARGET': return 'Este registro no admite esa decisión. Actualiza el lote y revisa su tipo.';
    case 'ASSET_NOT_SUGGESTED': return 'Selecciona uno de los activos sugeridos por la previsualización; no se permite vincular otro activo.';
    case 'NEW_ASSET_PROPOSAL_CONFLICT': return 'La identidad tiene coincidencias o no está confirmada. Revisa la evidencia antes de proponer un activo nuevo.';
    case 'IDEMPOTENCY_KEY_REUSED': return 'Esta solicitud ya está asociada a otra intención. Actualiza el historial antes de registrar una nueva intención.';
    case 'INVALID_REVIEW_SNAPSHOT': return 'No se pudo validar el origen guardado del lote. Solicita una revisión del servidor; no reemplaces su evidencia.';
    case 'PREVIEW_DATABASE_LIMIT': return 'El inventario supera el límite permitido para esta previsualización. Solicita una revisión del proceso de importación.';
    case 'IMPORT_CATALOG_LIMIT': return 'El catálogo supera los 5.000 productos compatibles con esta revisión. Solicita una revisión del proceso; puedes conservar tu selección y consultar el plan.';
    case 'PREVIEW_STALE': return 'La previsualización cambió. Genera y revisa una nueva antes de guardar el lote.';
    case 'PREVIEW_PAYLOAD_CONFLICT': return 'El contenido no coincide con la previsualización indicada. Conserva el origen y genera un análisis nuevo.';
    case 'PAYLOAD_TOO_LARGE': return 'El origen supera el tamaño permitido. Revisa los límites del extractor antes de continuar.';
    case 'INVALID_ACTIVATION_CODE': return 'El código de activación no es válido o expiró.';
    case 'RATE_LIMITED': return 'Demasiados intentos. Espera unos minutos e inténtalo nuevamente.';
    case 'INVALID_CURRENT_PASSWORD': return 'La contraseña actual no es correcta.';
    case 'ACCOUNT_PENDING': return 'La cuenta está pendiente de activación.';
    case 'FORBIDDEN': return 'No tienes permisos para realizar esta operación.';
    case 'SELF_ACCESS_RESET': return 'No puedes restablecer tu propio acceso desde Usuarios. Cambia tu contraseña en Mi cuenta.';
    case 'LAST_ADMIN_REQUIRED': return 'Debes mantener al menos un Jefe activo con su contraseña configurada. Activa otra cuenta de Jefe antes de continuar.';
    case 'CSRF_INVALID': return 'La sesión de seguridad expiró. Recarga la página e inténtalo nuevamente.';
    case 'UNAUTHENTICATED': return 'La sesión expiró. Inicia sesión nuevamente.';
    case 'INSUFFICIENT_STOCK': {
      const quantities = error.message.match(/Available:\s*(\d+);\s*requested:\s*(\d+)/i);
      return quantities ? `Stock insuficiente: hay ${quantities[1]} unidades disponibles y se requieren ${quantities[2]}.` : 'No hay stock suficiente para completar la operación.';
    }
    case 'PRODUCT_INACTIVE': return 'El producto está inactivo. Actívalo antes de registrar movimientos o activos.';
    case 'PRODUCT_TRACKING_MODE_LOCKED': return 'Este producto ya tiene existencias, movimientos o activos. Conserva su seguimiento actual; para otro seguimiento crea un producto distinto.';
    case 'ASSET_PRODUCT_UNSUPPORTED': return 'Selecciona un producto con seguimiento por cantidad.';
    case 'PRODUCT_NOT_ASSET': return 'Selecciona un producto con seguimiento por activo individual.';
    case 'INITIAL_ALREADY_EXISTS': return 'Este producto ya tiene stock inicial registrado. Utiliza una entrada para añadir unidades.';
    case 'ASSET_IDENTIFIER_CONFLICT': return 'La etiqueta o el número de serie ya pertenecen a otro activo.';
    case 'ASSET_INACTIVE': return 'El activo está inactivo y no puede asignarse.';
    case 'ASSET_NOT_ASSIGNABLE': return 'El activo no está disponible para asignación. Revisa su estado actual.';
    case 'ASSET_ALREADY_ASSIGNED': return 'El activo ya tiene una asignación activa. Registra su devolución antes de volver a asignarlo.';
    case 'ASSET_DECOMMISSIONED': return 'El activo está dado de baja y ya no admite cambios.';
    case 'ASSET_ASSIGNED': return 'Registra la devolución del activo antes de darlo de baja.';
    case 'ASSET_STATUS_UNCHANGED': return 'El activo ya tiene el estado seleccionado.';
    case 'RECIPIENT_REQUIRED': return 'Escribe el nombre y apellido de la persona que recibe el activo.';
    case 'ASSIGNMENT_REQUIRED': return 'Utiliza Asignar activo o Registrar devolución para cambiar una asignación.';
    case 'DECOMMISSION_REQUIRED': return 'Utiliza Dar de baja para retirar este activo de operación.';
    case 'ASSIGNMENT_DATE_CONFLICT': return 'La fecha se cruza con otra entrega o no es posterior a su inicio. Corrige la fecha efectiva o actualiza el historial.';
    case 'ASSIGNMENT_ALREADY_CLOSED': return 'La asignación ya fue cerrada. Actualiza el historial para ver la devolución.';
    case 'ASSET_ASSIGNMENT_INCONSISTENT': return 'La asignación no coincide con el estado del activo. Actualiza la información y solicita una revisión si el problema continúa.';
    case 'USER_INACTIVE': return 'El usuario está inactivo y no puede recibir una asignación.';
    case 'CORRECTION_NOT_SUPPORTED': return 'Selecciona un movimiento original de un producto por cantidad. Los ajustes compensatorios no se corrigen por separado.';
    case 'CORRECTION_ALREADY_EXISTS': return 'Este movimiento ya tiene una corrección pendiente. Espera su revisión antes de solicitar otra.';
    case 'CORRECTION_ALREADY_PROCESSED': return 'La corrección ya fue revisada. Actualiza el listado para ver su estado.';
    case 'CORRECTION_SELF_APPROVAL': return 'No puedes aprobar ni rechazar tu propia solicitud de corrección.';
    case 'CORRECTION_NO_CHANGE': return 'La cantidad final debe ser distinta de la cantidad vigente del movimiento.';
    case 'CORRECTION_INVALID_QUANTITY': return 'Ingresa una cantidad entera dentro del rango permitido y conserva el sentido del movimiento: las salidas descuentan y las entradas suman.';
    case 'CORRECTION_STALE': return 'El movimiento cambió después de crear esta solicitud. Actualiza la información y revisa las cantidades antes de continuar.';
    case 'STOCK_LIMIT_EXCEEDED': return 'La corrección supera el máximo de unidades permitido. Revisa la cantidad final.';
    default:
      if (error.status >= 500) return 'El servicio no pudo completar la solicitud. Actualiza la información e inténtalo nuevamente.';
      if (error.status === 401) return 'La sesión expiró. Inicia sesión nuevamente.';
      if (error.status === 403) return 'No tienes permisos para realizar esta operación.';
      if (error.status === 404) return 'El registro o servicio solicitado ya no está disponible. Actualiza la página.';
      if (error.status === 429) return 'Demasiadas solicitudes. Espera unos minutos e inténtalo nuevamente.';
      return fallback;
  }
}

export const SESSION_EXPIRED_EVENT = 'inventory:session-expired';

export async function apiRequest<T>(path: string, options: globalThis.RequestInit = {}): Promise<T> {
  const headers = new globalThis.Headers(options.headers);
  const hasBody = options.body !== undefined && options.body !== null && options.body !== '';
  if (hasBody && !(options.body instanceof globalThis.FormData)) {
    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
  }

  let response: globalThis.Response;
  let rawBody: string;
  try {
    response = await globalThis.fetch(`${environment.apiUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers
    });
    rawBody = await response.text();
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiRequestError('Network request failed', 0, 'NETWORK_ERROR');
  }
  let body: ApiErrorResponse | undefined;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as ApiErrorResponse;
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && body?.code !== 'INVALID_CURRENT_PASSWORD' && body?.code !== 'INVALID_CREDENTIALS') globalThis.dispatchEvent(new globalThis.Event(SESSION_EXPIRED_EVENT));
    throw new ApiRequestError(body?.message ?? 'No se pudo completar la operación', response.status, body?.code, body?.details);
  }

  if (!rawBody) return undefined as T;
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new ApiRequestError('Invalid JSON response', response.status, 'INVALID_RESPONSE');
  }
}

export async function getCsrfToken(signal?: globalThis.AbortSignal): Promise<string> {
  return (await apiRequest<{ csrfToken: string }>('/auth/csrf', { signal })).csrfToken;
}

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
    case 'INVALID_ACTIVATION_CODE': return 'El código de activación no es válido o expiró.';
    case 'RATE_LIMITED': return 'Demasiados intentos. Espera unos minutos e inténtalo nuevamente.';
    case 'INVALID_CURRENT_PASSWORD': return 'La contraseña actual no es correcta.';
    case 'ACCOUNT_PENDING': return 'La cuenta está pendiente de activación.';
    case 'FORBIDDEN': return 'No tienes permisos para realizar esta operación.';
    case 'CSRF_INVALID': return 'La sesión de seguridad expiró. Recarga la página e inténtalo nuevamente.';
    case 'UNAUTHENTICATED': return 'La sesión expiró. Inicia sesión nuevamente.';
    case 'INSUFFICIENT_STOCK': {
      const quantities = error.message.match(/Available:\s*(\d+);\s*requested:\s*(\d+)/i);
      return quantities ? `Stock insuficiente: hay ${quantities[1]} unidades disponibles y se requieren ${quantities[2]}.` : 'No hay stock suficiente para completar la operación.';
    }
    case 'PRODUCT_INACTIVE': return 'El producto está inactivo. Actívalo antes de registrar movimientos o activos.';
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

export async function getCsrfToken(): Promise<string> {
  return (await apiRequest<{ csrfToken: string }>('/auth/csrf')).csrfToken;
}

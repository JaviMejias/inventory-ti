import { useCallback, useEffect, useId, useRef, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { formatChilePhone, normalizeChilePhone } from '../../lib/formatting';
import { ApiRequestError, getApiErrorMessage, getApiFieldErrors, apiRequest, getCsrfToken } from '../../lib/api';
import { canViewUsers, type AppRole } from '../../lib/permissions';
import { useAuth, type AuthUser } from '../auth/auth-context';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Icon,
  ListFooter,
  ModuleFilters,
  ModuleHeader,
  PageContainer,
  Switch,
  OverflowText,
  Select,
  useToast,
  useRequestError,
  type DataTableColumn
} from '../../ui';

const ROLE_OPTIONS = [
  { value: 'JEFE', label: 'Jefe' },
  { value: 'COORDINADOR', label: 'Coordinador' },
  { value: 'SOPORTE', label: 'Soporte' }
];
const PAGE_SIZE = 25;
const FILTER_OPTIONS = [
  { value: 'all', label: 'Todos los usuarios' },
  { value: 'active', label: 'Usuarios activos' },
  { value: 'inactive', label: 'Usuarios inactivos' }
];

type ManagedUser = AuthUser;
type UserFilter = 'all' | 'active' | 'inactive';
type UserEditorState = { mode: 'new' } | { mode: 'edit'; user: ManagedUser };
type UserForm = { displayName: string; username: string; email: string; phone: string; role: AppRole };
type ConfirmTarget = { action: 'activate' | 'deactivate' | 'reset'; user: ManagedUser };
type ActivationNotice = { title: string; description: string; code: string };

const roleNames: Record<AppRole, string> = { JEFE: 'Jefe', COORDINADOR: 'Coordinador', SOPORTE: 'Soporte' };

function initialForm(state: UserEditorState): UserForm {
  if (state.mode === 'new') return { displayName: '', username: '', email: '', phone: '', role: 'SOPORTE' };
  return { displayName: state.user.displayName, username: state.user.username, email: state.user.email ?? '', phone: state.user.phone ?? '', role: state.user.role };
}

function statusFor(user: ManagedUser): 'active' | 'inactive' | 'pending' {
  if (!user.isActive) return 'inactive';
  return user.isActivated ? 'active' : 'pending';
}

function statusLabel(status: ReturnType<typeof statusFor>): string {
  return status === 'active' ? 'Activo' : status === 'inactive' ? 'Inactivo' : 'Pendiente de activación';
}

function userInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'U';
}

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const { showToast } = useToast();
  const reportError = useRequestError();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [filter, setFilter] = useState<UserFilter>('all');
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const searchInputId = useId();
  const searchInputRef = useRef<globalThis.HTMLInputElement>(null);
  const [searchComposing, setSearchComposing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editorState, setEditorState] = useState<UserEditorState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [activationNotice, setActivationNotice] = useState<ActivationNotice | null>(null);
  const [pendingActivationNotice, setPendingActivationNotice] = useState<ActivationNotice | null>(null);
  const pageRequestId = useRef(0);
  const pageLoading = useRef(false);

  const loadUsers = useCallback(async (offset = 0, append = false, signal?: globalThis.AbortSignal) => {
    if (append && pageLoading.current) return;
    const requestId = ++pageRequestId.current;
    pageLoading.current = true;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const params = new globalThis.URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (filter !== 'all') params.set('isActive', String(filter === 'active'));
      if (search.trim()) params.set('search', search.trim());
      const result = await apiRequest<{ users: ManagedUser[]; total: number; hasMore: boolean }>('/users?' + params.toString(), { signal });
      if (signal?.aborted || requestId !== pageRequestId.current) return;
      setUsers((current) => append ? [...current, ...result.users] : result.users);
      setTotal(result.total);
      setHasMore(result.hasMore);
    } catch (caughtError) {
      if (!signal?.aborted && requestId === pageRequestId.current) setError(getApiErrorMessage(caughtError, 'No se pudieron cargar los usuarios.'));
    } finally {
      if (!signal?.aborted && requestId === pageRequestId.current) {
        pageLoading.current = false;
        setLoadingMore(false);
        setLoading(false);
      }
    }

  }, [filter, search]);
  useEffect(() => {
    pageRequestId.current++;
    pageLoading.current = false;
    setLoading(true);
    if (searchComposing) return;
    const controller = new globalThis.AbortController();
    const timer = globalThis.setTimeout(() => { void loadUsers(0, false, controller.signal); }, search.trim() ? 300 : 0);
    return () => { globalThis.clearTimeout(timer); controller.abort(); };
  }, [loadUsers, search, searchComposing]);

  const visibleUsers = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase('es-CL');
    return users.filter((candidate) => {
      const matchesFilter = filter === 'all' || (filter === 'active' ? candidate.isActive : !candidate.isActive);
      if (!matchesFilter) return false;
      if (!normalized) return true;
      return [candidate.displayName, candidate.username, candidate.email ?? '', candidate.phone ?? '', roleNames[candidate.role]]
        .some((value) => value.toLocaleLowerCase('es-CL').includes(normalized));
    });
  }, [filter, search, users]);

  async function saveUser(form: UserForm, mode: UserEditorState['mode'], id?: string) {
    const token = await getCsrfToken();
    const payload = { displayName: form.displayName.trim(), username: form.username.trim(), email: form.email.trim(), phone: normalizeChilePhone(form.phone), role: form.role };
    if (mode === 'new') {
      const result = await apiRequest<{ user: ManagedUser; activationCode: string }>('/users', { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(payload) });
      setPendingActivationNotice({ title: 'Usuario creado', description: `La cuenta de ${result.user.displayName} está lista para su primer acceso.`, code: result.activationCode });
      showToast({ tone: 'success', title: 'Usuario creado', description: 'El código de activación está disponible una sola vez.' });
    } else if (id) {
      await apiRequest<{ user: ManagedUser }>(`/users/${id}`, { method: 'PATCH', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(payload) });
      showToast({ tone: 'success', title: 'Usuario actualizado', description: 'Los datos de acceso se guardaron correctamente.' });
    }
    setEditorOpen(false);
    await loadUsers();
  }

  async function confirmAction() {
    if (!confirmTarget) return;
    if (confirmTarget.action === 'reset' && confirmTarget.user.id === currentUser?.id) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const token = await getCsrfToken();
      const { action, user } = confirmTarget;
      if (action === 'reset') {
        const result = await apiRequest<{ user: ManagedUser; activationCode: string }>(`/users/${user.id}/reset-access`, { method: 'POST', headers: { 'X-CSRF-Token': token } });
        setPendingActivationNotice({ title: 'Acceso restablecido', description: `Comparte este código con ${user.displayName} para que configure una nueva contraseña.`, code: result.activationCode });
      } else {
        await apiRequest<{ user: ManagedUser }>(`/users/${user.id}/${action}`, { method: 'POST', headers: { 'X-CSRF-Token': token } });
        showToast({ tone: 'success', title: action === 'activate' ? 'Usuario activado' : 'Usuario desactivado', description: action === 'activate' ? `${user.displayName} puede volver a iniciar sesión.` : 'El acceso fue bloqueado y su historial se conserva.' });
      }
      setConfirmOpen(false);
      await loadUsers();
    } catch (caughtError) {
      setConfirmError(reportError(caughtError, 'No se pudo completar la operación'));
    } finally {
      setConfirmBusy(false);
    }
  }

  function openCreate() { setEditorState({ mode: 'new' }); setEditorOpen(true); }
  function openEdit(candidate: ManagedUser) { setEditorState({ mode: 'edit', user: candidate }); setEditorOpen(true); }
  function askAction(action: ConfirmTarget['action'], candidate: ManagedUser) { if (action === 'reset' && candidate.id === currentUser?.id) return; setConfirmError(null); setConfirmTarget({ action, user: candidate }); setConfirmOpen(true); }

  const columns: Array<DataTableColumn<ManagedUser>> = [
    { key: 'displayName', mobileRole: 'identity', mobileLabel: 'Usuario', header: <TableHeader icon={<UserIcon />}>Usuario</TableHeader>, className: 'users-col-identity', render: (candidate) => <UserIdentity user={candidate} /> },
    { key: 'role', mobileLabel: 'Rol', header: <TableHeader icon={<ShieldIcon />}>Rol</TableHeader>, className: 'users-col-role', render: (candidate) => <RoleBadge role={candidate.role} /> },
    { key: 'status', mobileLabel: 'Estado', header: <TableHeader icon={<StatusIcon />}>Estado</TableHeader>, className: 'users-col-status', render: (candidate) => <StatusBadge user={candidate} /> },
    { key: 'actions', mobileRole: 'actions', mobileLabel: 'Acciones', header: <TableHeader icon={<MoreIcon />}>Acciones</TableHeader>, className: 'users-col-actions', render: (candidate) => <UserActions candidate={candidate} canReset={candidate.id !== currentUser?.id} onEdit={() => openEdit(candidate)} onStatus={() => askAction(candidate.isActive ? 'deactivate' : 'activate', candidate)} onReset={() => askAction('reset', candidate)} /> }
  ];

  return <PageContainer fluid className="catalog-page users-page">
    <div className="catalog-surface users-catalog-surface">
      <ModuleHeader className="users-module-header" title="Gestión de usuarios" description="Administra las cuentas, roles y acceso de los usuarios del sistema." action={currentUser && canViewUsers(currentUser.role) && <Button onClick={openCreate}><PlusIcon />Nuevo usuario</Button>} />
      {error && <Alert className="catalog-error users-page-alert" variant="danger" icon={<AlertIcon />} action={<Button variant="secondary" size="sm" onClick={() => void loadUsers()}>Reintentar</Button>}>{error}</Alert>}
      <section className="catalog-section users-section" aria-labelledby="users-list-title">
        <h2 id="users-list-title" className="sr-only">Cuentas registradas</h2>
        <ModuleFilters className="catalog-toolbar users-toolbar" ariaLabel="Filtros de usuarios">
          <div className="catalog-search users-search">
            <label htmlFor={searchInputId}>Buscar</label>
            <span className="catalog-search-control users-search-control">
              <SearchIcon />
              <input id={searchInputId} ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} onCompositionStart={() => setSearchComposing(true)} onCompositionEnd={() => setSearchComposing(false)} placeholder="Nombre, usuario o correo" />
              <button type="button" className={`users-search-clear${search ? ' users-search-clear-visible' : ''}`} onClick={() => { setSearch(''); searchInputRef.current?.focus({ preventScroll: true }); }} aria-label="Limpiar búsqueda" tabIndex={search ? 0 : -1}><CloseIcon /></button>
            </span>
          </div>
          <label className="catalog-filter users-filter"><span>Estado</span><Select value={filter} onChange={(value) => setFilter(value as UserFilter)} options={FILTER_OPTIONS} /></label>
        </ModuleFilters>
        <div className="users-data-table-frame"><DataTable className="catalog-data-table users-data-table" rows={visibleUsers} columns={columns} getRowKey={(candidate) => candidate.id} caption="Usuarios registrados" error={visibleUsers.length === 0 ? error ?? undefined : undefined} loading={loading} loadingRows={6} empty={<EmptyState icon={<UsersIcon />} title={search || filter !== 'all' ? 'No hay coincidencias' : 'Todavía no hay usuarios'} description={search || filter !== 'all' ? 'Prueba con otros criterios de búsqueda.' : 'Crea el primer usuario para habilitar el acceso al sistema.'} action={search || filter !== 'all' ? <Button variant="secondary" onClick={() => { setSearch(''); setFilter('all'); }}>Limpiar filtros</Button> : <Button onClick={openCreate}><PlusIcon />Nuevo usuario</Button>} />} /></div>
        <UsersLoadMore error={error} loaded={users.length} total={total} hasMore={hasMore} loading={loadingMore} onLoadMore={() => void loadUsers(users.length, true)} />
      </section>
    </div>
    {editorState && <UserEditor key={editorState.mode === 'new' ? 'new' : editorState.user.id} state={editorState} open={editorOpen} onClose={() => setEditorOpen(false)} onExited={() => { setEditorState(null); if (pendingActivationNotice) { setActivationNotice(pendingActivationNotice); setPendingActivationNotice(null); } }} onSave={saveUser} />}
    <ConfirmDialog
      open={confirmOpen}
      className="catalog-editor-dialog users-confirm-dialog"
      loading={confirmBusy}
      error={confirmError}
      onClose={() => setConfirmOpen(false)}
      onExited={() => { setConfirmTarget(null); if (pendingActivationNotice) { setActivationNotice(pendingActivationNotice); setPendingActivationNotice(null); } }}
      onConfirm={() => void confirmAction()}
      title={confirmTarget ? <span className="catalog-dialog-title"><span className="catalog-dialog-icon">{confirmTarget.action === 'reset' ? <KeyIcon /> : <ShieldIcon />}</span>{confirmTitle(confirmTarget)}</span> : 'Confirmar acción'}
      description={confirmTarget ? confirmDescription(confirmTarget) : ''}
      confirmLabel={confirmTarget ? confirmButtonLabel(confirmTarget) : 'Confirmar'}
      danger={confirmTarget?.action === 'deactivate'}
    />
    <ActivationCodeDialog notice={activationNotice} onClose={() => setActivationNotice(null)} />
    {currentUser && !canViewUsers(currentUser.role) && <span className="sr-only">Esta vista requiere permisos de jefe.</span>}
  </PageContainer>;
}

function UsersLoadMore({ loaded, total, hasMore, loading, error, onLoadMore }: { error?: string | null; loaded: number; total: number; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  return <ListFooter loaded={loaded} total={total} hasMore={hasMore} loading={loading} onLoadMore={onLoadMore} />;
}

function confirmTitle(target: ConfirmTarget): string {
  if (target.action === 'reset') return 'Restablecer acceso';
  return target.action === 'activate' ? 'Activar usuario' : 'Desactivar usuario';
}
function confirmDescription(target: ConfirmTarget): string {
  if (target.action === 'reset') return `Se invalidará el acceso actual de ${target.user.displayName} y se generará un código de activación de un solo uso. La persona deberá configurar una nueva contraseña.`;
  if (target.action === 'activate') return `${target.user.displayName} podrá volver a iniciar sesión en Inventory TI.`;
  return `El usuario no podrá iniciar sesión mientras permanezca desactivado. Sus registros históricos se conservarán.`;
}
function confirmButtonLabel(target: ConfirmTarget): string { return target.action === 'reset' ? 'Restablecer acceso' : target.action === 'activate' ? 'Activar usuario' : 'Desactivar usuario'; }

function UserEditor({ state, open, onClose, onExited, onSave }: { state: UserEditorState; open: boolean; onClose: () => void; onExited: () => void; onSave: (form: UserForm, mode: UserEditorState['mode'], id?: string) => Promise<void> }) {
  const [form, setForm] = useState<UserForm>(() => initialForm(state));
  const [errors, setErrors] = useState<Partial<Record<keyof UserForm, string>>>({});
  const [busy, setBusy] = useState(false);
  const isEdit = state.mode === 'edit';
  const reportError = useRequestError();

  function update<K extends keyof UserForm>(key: K, value: UserForm[K]) { setForm((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: undefined })); }
  async function submit(event: FormEvent<globalThis.HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const validation: typeof errors = {};
    if (!form.displayName.trim()) validation.displayName = 'Escribe el nombre completo del usuario.';
    if (!/^[A-Za-z0-9._-]{3,100}$/.test(form.username.trim())) validation.username = 'Usa entre 3 y 100 letras, números, puntos, guiones o guiones bajos.';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) validation.email = 'Ingresa un correo válido.';
    if (!/^[0-9+().\-\s]{7,40}$/.test(form.phone.trim())) validation.phone = 'Ingresa un teléfono válido.';
    setErrors(validation);
    if (Object.keys(validation).length) return;
    setBusy(true);
    try { await onSave(form, state.mode, state.mode === 'edit' ? state.user.id : undefined); }
    catch (caughtError) {
      reportError(caughtError, 'No se pudo guardar el usuario');
      if (caughtError instanceof ApiRequestError && caughtError.code === 'CONFLICT') {
        const details = caughtError.details;
        const field = typeof details === 'object' && details !== null && 'field' in details && (details.field === 'username' || details.field === 'email') ? details.field : undefined;
        const message = 'Este usuario o correo ya está registrado.';
        setErrors(field ? { [field]: message } : { username: message, email: message });
      }
      else setErrors(getApiFieldErrors(caughtError, { displayName: 'displayName', username: 'username', email: 'email', phone: 'phone', role: 'role' }));
      setBusy(false);
    }
  }

  return <Dialog className="catalog-editor-dialog users-editor-dialog" open={open} onClose={onClose} onExited={onExited} busy={busy} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon"><UsersIcon /></span>{isEdit ? 'Editar usuario' : 'Nuevo usuario'}</span>} description="Gestiona la identidad y el rol. La contraseña se configura durante el primer acceso." actions={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button form="user-editor-form" type="submit" loading={busy}><CheckIcon />{isEdit ? 'Guardar cambios' : 'Crear usuario'}</Button></>}>
    <form id="user-editor-form" noValidate onSubmit={(event) => void submit(event)}><div className="users-editor-grid"><Field label="Nombre completo" required error={errors.displayName}><input value={form.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder="Ej. Juan Pérez" autoComplete="name" /></Field><Field label="Usuario" required hint="Usa letras, números, punto, guion o guion bajo." error={errors.username}><input value={form.username} onChange={(event) => update('username', event.target.value)} placeholder="Ej. juan.perez" autoComplete="username" /></Field><Field label="Correo" required error={errors.email}><input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} placeholder="nombre@chilexpress.cl" autoComplete="email" /></Field><Field label="Teléfono" required error={errors.phone}><input value={form.phone.trim() ? formatChilePhone(form.phone) : ''} onChange={(event) => update('phone', event.target.value)} placeholder="+56 9 1234 5678" autoComplete="tel" /></Field><Field label="Rol" required hint="El backend aplicará los permisos asociados al rol." error={errors.role}><Select value={form.role} onChange={(value) => update('role', value as AppRole)} options={ROLE_OPTIONS} /></Field></div></form>
  </Dialog>;
}

function ActivationCodeDialog({ notice, onClose }: { notice: ActivationNotice | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copyCode() {
    if (!notice) return;
    try { await globalThis.navigator.clipboard.writeText(notice.code); }
    catch { const textarea = document.createElement('textarea'); textarea.value = notice.code; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.opacity = '0'; document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove(); }
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 2000);
  }
  return <Dialog className="catalog-editor-dialog activation-code-dialog" open={Boolean(notice)} onClose={onClose} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon catalog-dialog-icon-product"><KeyIcon /></span>{notice?.title ?? 'Código de activación'}</span>} description="Código de un solo uso. Cópialo y compártelo de forma segura." actions={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
    <div className="activation-code-content"><div className="activation-code-callout"><KeyIcon /><span>{notice?.description}</span></div><div className="activation-code-line"><code className="activation-code-value">{notice?.code ?? ''}</code><button className="activation-copy-button" type="button" onClick={() => void copyCode()} title={copied ? 'Código copiado' : 'Copiar código'} aria-label={copied ? 'Código copiado' : 'Copiar código'}>{copied ? <CheckIcon /> : <CopyIcon />}</button>{copied && <span className="activation-copy-feedback" role="status">Copiado</span>}</div><p className="activation-code-warning"><AlertIcon /> Cierra este diálogo para ocultar el código. Si lo pierdes, deberás restablecer el acceso.</p></div>
  </Dialog>;
}

function UserIdentity({ user }: { user: ManagedUser }) { return <div className="users-identity"><span className="users-avatar" aria-hidden="true">{userInitials(user.displayName)}</span><span className="users-identity-copy"><OverflowText as="strong" text={user.displayName} /><OverflowText as="small" text={`@${user.username}`} /></span></div>; }
function UserActions({ candidate, canReset, onEdit, onStatus, onReset }: { candidate: ManagedUser; canReset: boolean; onEdit: () => void; onStatus: () => void; onReset: () => void }) { return <div className="users-row-actions"><Button variant="ghost" size="sm" onClick={onEdit}><EditIcon />Editar</Button><span className="users-status-switch"><Switch checked={candidate.isActive} onCheckedChange={onStatus} aria-label={'Cambiar estado de ' + candidate.displayName} title={candidate.isActive ? 'Desactivar usuario' : 'Activar usuario'} /></span><Button variant="ghost" size="sm" onClick={onReset} disabled={!canReset} title={canReset ? 'Restablecer acceso' : 'Cambia tu contraseña en Mi cuenta'}><KeyIcon />Restablecer</Button></div>; }
function RoleBadge({ role }: { role: AppRole }) { return <Badge className={'users-role-badge users-role-' + role.toLowerCase()} variant={role === 'JEFE' ? 'default' : role === 'COORDINADOR' ? 'info' : 'success'}><ShieldIcon /><OverflowText text={roleNames[role]} /></Badge>; }
function StatusBadge({ user }: { user: ManagedUser }) { const status = statusFor(user); return <Badge className={'users-status-badge users-status-' + status} variant={status === 'active' ? 'success' : status === 'inactive' ? 'danger' : 'warning'}>{status === 'active' ? <CheckIcon /> : status === 'inactive' ? <DeactivateIcon /> : <ClockIcon />}<OverflowText text={statusLabel(status)} /></Badge>; }
function TableHeader({ icon, children }: { icon: ReactNode; children: ReactNode }) { return <span className="users-table-header">{icon}{children}</span>; }

export function ForbiddenPage() { return <PageContainer fluid className="forbidden-page"><div className="forbidden-panel"><span className="forbidden-icon"><ShieldIcon /></span><p className="app-page-kicker">Acceso restringido</p><h1>No puedes abrir esta sección.</h1><p>La administración de usuarios está disponible únicamente para el rol Jefe.</p><Link className="ui-button ui-button-primary ui-button-md" to="/">Volver al inicio</Link></div></PageContainer>; }

function LineIcon({ children }: { children: ReactNode }) { return <Icon className="users-icon-svg">{children}</Icon>; }
function UserIcon() { return <LineIcon><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></LineIcon>; }
function UsersIcon() { return <LineIcon><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 4 5" /></LineIcon>; }
function ShieldIcon() { return <LineIcon><path d="M12 3 19 6v5c0 4.6-2.8 8-7 10-4.2-2-7-5.4-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></LineIcon>; }
function StatusIcon() { return <LineIcon><circle cx="12" cy="12" r="8" /><path d="m8 12 2.5 2.5L16 9" /></LineIcon>; }
function MoreIcon() { return <LineIcon><circle cx="6" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="18" cy="12" r="1" fill="currentColor" /></LineIcon>; }
function PlusIcon() { return <LineIcon><path d="M12 5v14M5 12h14" /></LineIcon>; }
function CheckIcon() { return <LineIcon><path d="m5 12 4 4L19 6" /></LineIcon>; }
function KeyIcon() { return <LineIcon><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M16 7l2 2M13 10l2 2" /></LineIcon>; }
function EditIcon() { return <LineIcon><path d="m4 16.5-.8 3.3 3.3-.8L18 7.5 15.5 5 4 16.5Z" /><path d="m14.5 6 2.5 2.5" /></LineIcon>; }
function DeactivateIcon() { return <LineIcon><path d="M12 4v16M5 12h14" /></LineIcon>; }
function ClockIcon() { return <LineIcon><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></LineIcon>; }
function CopyIcon() { return <LineIcon><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></LineIcon>; }
function SearchIcon() { return <LineIcon><circle cx="10.8" cy="10.8" r="6.2" /><path d="m16 16 4 4" /></LineIcon>; }
function CloseIcon() { return <LineIcon><path d="m6 6 12 12M18 6 6 18" /></LineIcon>; }
function AlertIcon() { return <LineIcon><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></LineIcon>; }

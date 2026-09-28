import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { apiRequest, getCsrfToken } from '../../lib/api';
import { formatChilePhone, normalizeChilePhone } from '../../lib/formatting';
import { useAuth } from './auth-context';
import { Alert, Badge, Button, Dialog, Field, Icon, PageContainer, useToast, useRequestError } from '../../ui';

const roleNames = { JEFE: 'Jefe', COORDINADOR: 'Coordinador', SOPORTE: 'Soporte' } as const;

export function AccountPage() {
  const { user, updateProfile } = useAuth();
  const { showToast } = useToast();
  const reportError = useRequestError();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileForm>({ displayName: '', email: '', phone: '' });
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  useEffect(() => {
    if (user && !profileEditing) setProfileDraft({ displayName: user.displayName, email: user.email ?? '', phone: user.phone ?? '' });
  }, [profileEditing, user]);

  if (!user) return null;
  const currentUser = user;
  const status = !user.isActive ? { label: 'Inactivo', variant: 'danger' as const } : !user.isActivated ? { label: 'Pendiente de activación', variant: 'warning' as const } : { label: 'Activo', variant: 'success' as const };

  const initials = user.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const roleLabel = roleNames[user.role];

  function startProfileEdit() {
    setProfileDraft({ displayName: currentUser.displayName, email: currentUser.email ?? '', phone: currentUser.phone ?? '' });
    setProfileError(null);
    setProfileEditing(true);
  }

  function cancelProfileEdit() {
    if (profileBusy) return;
    setProfileDraft({ displayName: currentUser.displayName, email: currentUser.email ?? '', phone: currentUser.phone ?? '' });
    setProfileError(null);
    setProfileEditing(false);
  }

  function requestProfileSave() {
    const form = globalThis.document.getElementById('account-inline-profile-form');
    if (form instanceof globalThis.HTMLFormElement) form.requestSubmit();
  }

  async function submitProfile(event: FormEvent<globalThis.HTMLFormElement>) {
    event.preventDefault();
    const displayName = profileDraft.displayName.trim();
    const email = profileDraft.email.trim();
    const phone = profileDraft.phone.trim();
    if (!displayName) { setProfileError('Escribe tu nombre completo.'); return; }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) { setProfileError('Ingresa un correo válido.'); return; }
    if (phone && !/^[0-9+().\-\s]{7,40}$/.test(phone)) { setProfileError('Ingresa un teléfono válido.'); return; }
    setProfileBusy(true);
    setProfileError(null);
    try {
      await updateProfile({ displayName, email: email || null, phone: phone ? normalizeChilePhone(phone) : null });
      setProfileEditing(false);
      showToast({ tone: 'success', title: 'Información actualizada', description: 'Tus datos personales se guardaron correctamente.' });
    } catch (caughtError) {
      setProfileError(reportError(caughtError, 'No se pudo actualizar tu información'));
    } finally {
      setProfileBusy(false);
    }
  }

  return <PageContainer fluid className="account-page">
    <header className="account-resume-masthead">
      <div className="account-resume-kicker"><span><SparkIcon />Perfil personal</span><span>Inventory TI / Ficha personal</span></div>
      <div className="account-resume-title-row"><div><h1>Mi cuenta</h1><p>Consulta tu identidad y administra los datos que mantienes dentro de la operación.</p></div></div>
    </header>

    <div className="account-resume-content account-profile-layout">
      <main className="account-resume-main account-management-column">
        <section className="account-resume-section account-management-panel" aria-labelledby="account-management-title">
          <div className="account-resume-section-heading"><span className="account-resume-section-icon"><EditIcon /></span><div><p className="account-resume-overline">Administrar cuenta</p><h2 id="account-management-title">{profileEditing ? 'Editar información' : 'Acciones de perfil'}</h2><p>{profileEditing ? 'Actualiza tus datos personales y guarda los cambios cuando termines.' : 'Modifica tus datos personales o protege tu acceso.'}</p></div></div>
          {profileEditing ? <form id="account-inline-profile-form" className="account-inline-profile-form" noValidate onSubmit={(event) => void submitProfile(event)}><div className="account-inline-profile-grid"><Field label="Nombre completo" required><input autoFocus value={profileDraft.displayName} onChange={(event) => setProfileDraft((current) => ({ ...current, displayName: event.target.value }))} autoComplete="name" placeholder="Ej. Juan Pérez" disabled={profileBusy} /></Field><Field label="Correo electrónico"><input type="email" value={profileDraft.email} onChange={(event) => setProfileDraft((current) => ({ ...current, email: event.target.value }))} autoComplete="email" placeholder="correo corporativo" disabled={profileBusy} /></Field><Field label="Teléfono"><input value={profileDraft.phone} onChange={(event) => setProfileDraft((current) => ({ ...current, phone: event.target.value }))} autoComplete="tel" placeholder="+56 9 1234 5678" disabled={profileBusy} /></Field><Field label="Usuario de acceso" hint="Identificador único de la cuenta."><input className="account-inline-readonly" value={user.username} readOnly aria-readonly="true" /></Field>{profileError && <Alert variant="danger" icon={<AlertIcon />}>{profileError}</Alert>}</div><div className="account-management-actions"><Button className="account-cancel-button" variant="secondary" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); cancelProfileEdit(); }} disabled={profileBusy}>Cancelar</Button><Button className="account-save-button" type="button" onClick={requestProfileSave} loading={profileBusy}><CheckIcon />Guardar cambios</Button></div></form> : <div className="account-management-options"><article className="account-management-option"><span className="account-management-option-icon"><UserIcon /></span><div><strong>Información personal</strong><p>Nombre, correo electrónico y teléfono.</p></div><Button variant="secondary" size="sm" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); startProfileEdit(); }}><EditIcon />Editar</Button></article><article className="account-management-option"><span className="account-management-option-icon account-management-option-icon-security"><LockIcon /></span><div><strong>Contraseña</strong><p>Actualiza tu clave y cierra sesiones anteriores.</p></div><Button variant="secondary" size="sm" type="button" onClick={() => setPasswordOpen(true)}><LockIcon />Cambiar</Button></article></div>}
        </section>

      </main>

      <aside className="account-resume-sidebar account-profile-column">
        <section className="account-resume-hero account-profile-card" aria-labelledby="account-profile-title">
          <div className="account-resume-hero-main">
            <div className="account-resume-avatar" aria-hidden="true"><strong>{initials || 'IT'}</strong><span>IT</span></div>
            <div className="account-resume-identity"><p className="account-resume-overline">Perfil interno · {roleLabel}</p><h2 id="account-profile-title">{user.displayName}</h2><p className="account-resume-username">@{user.username}</p><div className="account-resume-chips"><Badge variant={status.variant}>{status.label}</Badge><span className="account-verified-chip"><ShieldIcon />Acceso verificado</span></div></div>
          </div>
          <div className="account-resume-facts" aria-label="Resumen de cuenta"><div><span>Cuenta</span><strong>Inventory TI</strong></div><div><span>Rol operativo</span><strong>{roleLabel}</strong></div><div><span>Estado</span><strong className={`account-fact-status account-fact-status-${status.variant}`}>{status.label}</strong></div></div>
        </section>

        <section className="account-resume-section account-profile-details" aria-labelledby="account-contact-title">
          <div className="account-resume-section-heading"><span className="account-resume-section-icon"><UserIcon /></span><div><p className="account-resume-overline">Ficha personal</p><h2 id="account-contact-title">Datos de contacto</h2><p>La información visible de tu perfil dentro de Inventory TI.</p></div></div>
          <div className="account-contact-grid"><AccountInfoCard icon={<UserIcon />} label="Nombre completo" value={user.displayName} accent /><AccountInfoCard icon={<MailIcon />} label="Correo electrónico" value={user.email || 'No informado'} /><AccountInfoCard icon={<PhoneIcon />} label="Teléfono" value={formatChilePhone(user.phone)} /><AccountInfoCard icon={<AtIcon />} label="Usuario de acceso" value={user.username} technical /></div>
        </section>
      </aside>
    </div>

    <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} onSaved={() => { setPasswordOpen(false); showToast({ tone: 'success', title: 'Contraseña actualizada', description: 'Las demás sesiones se cerraron por seguridad.' }); }} />
  </PageContainer>;

}

type ProfileForm = { displayName: string; email: string; phone: string };

function ChangePasswordDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const reportError = useRequestError();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  function close() { if (busy) return; setCurrentPassword(''); setNewPassword(''); setError(null); onClose(); }
  async function submit(event: FormEvent<globalThis.HTMLFormElement>) {
    event.preventDefault();
    if (newPassword.length < 12) { setError('La nueva contraseña debe tener al menos 12 caracteres.'); return; }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) { setError('La nueva contraseña debe incluir al menos una letra y un número.'); return; }
    setBusy(true); setError(null);
    try { const token = await getCsrfToken(); await apiRequest('/auth/password', { method: 'POST', headers: { 'X-CSRF-Token': token }, body: JSON.stringify({ currentPassword, newPassword }) }); setCurrentPassword(''); setNewPassword(''); onSaved(); }
    catch (caughtError) { setError(reportError(caughtError, 'No se pudo cambiar la contraseña')); }
    finally { setBusy(false); }
  }
  return <Dialog className="catalog-editor-dialog account-password-dialog" open={open} onClose={close} busy={busy} title={<span className="catalog-dialog-title"><span className="catalog-dialog-icon"><LockIcon /></span>Cambiar contraseña</span>} description="La contraseña debe tener al menos 12 caracteres, una letra y un número." actions={<><Button variant="secondary" onClick={close} disabled={busy}>Cancelar</Button><Button form="account-password-form" type="submit" loading={busy}><CheckIcon />Guardar contraseña</Button></>}><form id="account-password-form" noValidate onSubmit={(event) => void submit(event)}><div className="account-password-fields"><Field label="Contraseña actual" required><PasswordInput value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /></Field><Field label="Nueva contraseña" required hint="Usa 12 caracteres como mínimo, con al menos una letra y un número."><PasswordInput value={newPassword} onChange={setNewPassword} autoComplete="new-password" /></Field>{error && <Alert variant="danger" icon={<AlertIcon />}>{error}</Alert>}</div></form></Dialog>;
}

type PasswordInputProps = { value: string; onChange: (value: string) => void; autoComplete: string; id?: string; className?: string; disabled?: boolean; required?: boolean; 'aria-describedby'?: string; 'aria-invalid'?: boolean };
function PasswordInput({ value, onChange, autoComplete, id, className, disabled, required, ...aria }: PasswordInputProps) { const [visible, setVisible] = useState(false); return <div className="account-password-control"><input id={id} className={className} type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} disabled={disabled} required={required} {...aria} /><button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={visible}>{visible ? <EyeOffIcon /> : <EyeIcon />}</button></div>; }
function AccountInfoCard({ icon, label, value, technical = false, accent = false }: { icon: ReactNode; label: string; value: string; technical?: boolean; accent?: boolean }) { return <article className={`account-info-card${accent ? ' account-info-card-accent' : ''}`}><span className="account-info-icon">{icon}</span><div><span className="account-info-label">{label}</span><strong className={technical ? 'account-info-technical' : undefined}>{value}</strong></div></article>; }
function LineIcon({ children }: { children: ReactNode }) { return <Icon className="account-icon-svg">{children}</Icon>; }
function SparkIcon() { return <LineIcon><path d="m12 3 1.1 5.9L19 10l-5.9 1.1L12 17l-1.1-5.9L5 10l5.9-1.1L12 3Z" /><path d="m19 16 .5 2.5L22 19l-2.5.5L19 22l-.5-2.5L16 19l2.5-.5L19 16Z" /></LineIcon>; }
function EditIcon() { return <LineIcon><path d="m4 16.5-.8 3.3 3.3-.8L18 7.5 15.5 5 4 16.5Z" /><path d="m14.5 6 2.5 2.5" /></LineIcon>; }
function UserIcon() { return <LineIcon><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></LineIcon>; }
function AtIcon() { return <LineIcon><circle cx="12" cy="12" r="4" /><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3 6.7" /></LineIcon>; }
function MailIcon() { return <LineIcon><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></LineIcon>; }
function PhoneIcon() { return <LineIcon><path d="M7 4h3l1.5 4-2 1.5a14 14 0 0 0 5 5l1.5-2 4 1.5v3A2 2 0 0 1 18 19 13 13 0 0 1 5 6a2 2 0 0 1 2-2Z" /></LineIcon>; }
function ShieldIcon() { return <LineIcon><path d="M12 3 19 6v5c0 4.6-2.8 8-7 10-4.2-2-7-5.4-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></LineIcon>; }
function LockIcon() { return <LineIcon><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></LineIcon>; }
function CheckIcon() { return <LineIcon><path d="m5 12 4 4L19 6" /></LineIcon>; }
function EyeIcon() { return <LineIcon><path d="M2.5 12s3.2-5 9.5-5 9.5 5 9.5 5-3.2 5-9.5 5-9.5-5-9.5-5Z" /><circle cx="12" cy="12" r="2" /></LineIcon>; }
function EyeOffIcon() { return <LineIcon><path d="m3 3 18 18M10.6 6.9A10.6 10.6 0 0 1 12 7c6.3 0 9.5 5 9.5 5a17.5 17.5 0 0 1-3.1 3.4M6.2 6.2C3.8 7.6 2.5 10 2.5 12c0 0 3.2 5 9.5 5 1.4 0 2.6-.3 3.7-.7" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></LineIcon>; }
function AlertIcon() { return <LineIcon><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></LineIcon>; }

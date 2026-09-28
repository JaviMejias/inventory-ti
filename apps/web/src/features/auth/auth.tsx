import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { ApiRequestError, apiRequest, getApiErrorMessage, getCsrfToken, SESSION_EXPIRED_EVENT } from '../../lib/api';
import { AuthContext, type AuthContextValue, type AuthUser, useAuth } from './auth-context';
import { useRequestError } from '../../ui/feedback/useRequestError';
import { Button } from '../../ui/primitives/Button';
import { ThemeSwitcher } from '../../ui/ThemeSwitcher';

export function AuthProvider({ children }: { children: ReactNode }) {
  const reportError = useRequestError();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    apiRequest<{ user: AuthUser }>('/auth/me')
      .then((response) => {
        if (active) setUser(response.user);
      })
      .catch((caughtError) => {
        if (!active) return;
        setUser(null);
        if (!(caughtError instanceof ApiRequestError && caughtError.status === 401)) reportError(caughtError, 'No se pudo comprobar la sesión');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reportError]);

  useEffect(() => {
    const handleSessionExpired = () => setUser(null);
    globalThis.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => globalThis.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isLoading,
    async login(identifier, password) {
      const response = await apiRequest<{ user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password })
      });
      setUser(response.user);
    },
    async logout() {
      try {
        const token = await getCsrfToken();
        await apiRequest('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) {
          setUser(null);
          return;
        }
        throw error;
      }
      setUser(null);
    },
    async updateProfile(input) {
      const token = await getCsrfToken();
      const response = await apiRequest<{ user: AuthUser }>('/auth/me', { method: 'PATCH', headers: { 'X-CSRF-Token': token }, body: JSON.stringify(input) });
      setUser(response.user);
    }
  }), [isLoading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function LoginPage() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ identifier?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingActivation, setPendingActivation] = useState(false);
  const [activationView, setActivationView] = useState(false);

  useEffect(() => {
    const previousTitle = globalThis.document.title;
    globalThis.document.title = 'Iniciar sesión — Inventory TI';
    return () => { globalThis.document.title = previousTitle; };
  }, []);

  if (activationView) return <ActivationPage initialIdentifier={identifier} onBack={() => { setActivationView(false); setPendingActivation(false); setErrors({}); setFormError(null); }} />;

  async function submit(event: FormEvent<globalThis.HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const validation = {
      ...(!identifier.trim() ? { identifier: 'Ingresa tu usuario o correo.' } : {}),
      ...(identifier.trim().length > 255 ? { identifier: 'El usuario o correo no puede superar 255 caracteres.' } : {}),
      ...(!password ? { password: 'Ingresa tu contraseña.' } : {}),
      ...(password.length > 128 ? { password: 'La contraseña no puede superar 128 caracteres.' } : {})
    };
    if (Object.keys(validation).length) {
      setErrors(validation);
      globalThis.document.getElementById(!identifier.trim() ? 'login-identifier' : 'login-password')?.focus();
      return;
    }
    setErrors({});
    setFormError(null);
    setPendingActivation(false);
    setIsSubmitting(true);
    try {
      await login(identifier, password);
    } catch (caughtError) {
      const message = getApiErrorMessage(caughtError, 'No se pudo iniciar sesión.');
      if (caughtError instanceof ApiRequestError && caughtError.code === 'INVALID_CREDENTIALS') {
        const neutralMessage = 'Revisa tu usuario o correo y tu contraseña.';
        setErrors({ identifier: neutralMessage, password: neutralMessage });
      } else if (caughtError instanceof ApiRequestError && caughtError.code === 'ACCOUNT_PENDING') {
        setErrors({ identifier: message });
      } else {
        setFormError(message);
      }
      if (caughtError instanceof ApiRequestError && caughtError.code === 'ACCOUNT_PENDING') setPendingActivation(true);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-page auth-login-page">
      <div className="auth-shell auth-login-shell">
        <AuthHeader />
        <section className="auth-story auth-login-story" aria-label="Sobre Inventory TI">
          <div className="auth-story-grid" aria-hidden="true" />
          <div className="auth-login-story-content auth-reveal">
            <span className="auth-login-eyebrow">Control de inventario TI</span>
            <h2>Tu inventario,<br /><span>bajo control.</span></h2>
            <p>Productos, stock y activos en un mismo lugar.</p>
          </div>
          <InventoryIllustration />
        </section>

        <section className="auth-form-panel auth-login-panel" aria-labelledby="login-title">
          <div className="auth-login-content">
            <div className="auth-login-heading auth-reveal">
              <span className="auth-login-access-icon" aria-hidden="true"><LockIcon /></span>
              <h1 id="login-title">Iniciar sesión</h1>
              <p>Usa tu usuario o correo corporativo.</p>
            </div>

            <form className="auth-login-form auth-reveal auth-reveal-delay" onSubmit={submit} aria-busy={isSubmitting || undefined} noValidate>
              <div className="auth-login-field">
                <label htmlFor="login-identifier">Usuario o correo</label>
                <div className="auth-login-input-wrap">
                  <UserIcon className="auth-login-input-icon" />
                  <input id="login-identifier" className="auth-input" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Tu usuario o correo" value={identifier} onChange={(event) => { setIdentifier(event.target.value); setFormError(null); setErrors((current) => current.identifier && current.password ? {} : { ...current, identifier: undefined }); }} aria-invalid={Boolean(errors.identifier)} aria-describedby={errors.identifier ? errors.password ? 'login-credentials-error' : 'login-identifier-error' : undefined} disabled={isSubmitting} required />
                </div>
                {errors.identifier && !errors.password && <p className="auth-login-field-error" id="login-identifier-error" role="alert">{errors.identifier}</p>}
              </div>
              <div className="auth-login-field">
                <label htmlFor="login-password">Contraseña</label>
                <div className="auth-login-input-wrap">
                  <LockIcon className="auth-login-input-icon" />
                  <input id="login-password" className="auth-input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Tu contraseña" value={password} onChange={(event) => { setPassword(event.target.value); setFormError(null); setErrors((current) => current.identifier && current.password ? {} : { ...current, password: undefined }); }} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? errors.identifier ? 'login-credentials-error' : 'login-password-error' : undefined} disabled={isSubmitting} required />
                  <Button className="auth-login-password-toggle" variant="ghost" iconOnly onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} title={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword} disabled={isSubmitting}>{showPassword ? <EyeOffIcon /> : <EyeIcon />}</Button>
                </div>
                {errors.password && !errors.identifier && <p className="auth-login-field-error" id="login-password-error" role="alert">{errors.password}</p>}
              </div>
              {errors.identifier && errors.password && <p className="auth-login-field-error" id="login-credentials-error" role="alert">{errors.identifier}</p>}
              {formError && <p className="auth-login-field-error" id="login-form-error" role="alert">{formError}</p>}
              <Button className="auth-login-submit" type="submit" size="lg" loading={isSubmitting} aria-label={isSubmitting ? 'Iniciando sesión…' : 'Iniciar sesión'}>Iniciar sesión<ArrowRightIcon /></Button>
              {pendingActivation && <Button variant="secondary" disabled={isSubmitting} onClick={() => setActivationView(true)}>Configurar contraseña</Button>}
            </form>

            <p className="auth-login-footer"><ShieldIcon />Acceso interno de Chilexpress</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function ActivationPage({ initialIdentifier, onBack }: { initialIdentifier: string; onBack: () => void }) {
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [activationCode, setActivationCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    const previousTitle = globalThis.document.title;
    globalThis.document.title = completed ? 'Cuenta activada — Inventory TI' : 'Activar cuenta — Inventory TI';
    return () => { globalThis.document.title = previousTitle; };
  }, [completed]);

  async function submit(event: FormEvent<globalThis.HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 12) { setError('La contraseña debe tener al menos 12 caracteres.'); return; }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { setError('La contraseña debe incluir al menos una letra y un número.'); return; }
    if (password !== confirmation) { setError('Las contraseñas no coinciden.'); return; }
    setBusy(true); setError(null);
    try { await apiRequest('/auth/activate', { method: 'POST', body: JSON.stringify({ identifier: identifier.trim(), activationCode: activationCode.trim(), password, passwordConfirmation: confirmation }) }); setCompleted(true); setPassword(''); setConfirmation(''); }
    catch (caughtError) { setError(getApiErrorMessage(caughtError, 'No se pudo activar la cuenta.')); setBusy(false); }
  }

  return <main className="auth-page relative flex min-h-dvh items-center overflow-hidden px-4 py-6 sm:px-6 lg:py-10"><div className="auth-shell auth-activation-shell relative mx-auto grid w-full max-w-[73.75rem] overflow-hidden rounded-[1.5rem] lg:grid-cols-[0.88fr_1.12fr]"><AuthHeader /><section className="auth-story relative hidden min-h-[42rem] overflow-hidden p-10 lg:block xl:p-14"><div className="auth-story-grid absolute inset-0" aria-hidden="true" /><div className="relative z-10 flex h-full flex-col"><div className="auth-reveal mt-auto max-w-xl pb-10 pt-20"><p className="mb-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-[var(--auth-brand)]"><span className="h-2 w-2 rounded-full bg-[var(--auth-brand)] auth-pulse" aria-hidden="true" /> Primer acceso</p><h1 className="max-w-lg text-5xl font-semibold leading-[1.02] tracking-[-0.045em] text-white xl:text-6xl">Activa tu acceso al <span className="text-[var(--auth-brand)]">centro TI.</span></h1><p className="mt-6 max-w-md text-base leading-7 text-slate-300">Configura una contraseña personal con el código entregado por tu administrador.</p></div></div></section><section className="auth-form-panel flex min-h-[42rem] items-center px-6 py-10 sm:px-12 lg:min-h-[42rem] xl:px-16"><div className="mx-auto w-full max-w-md">{completed ? <div className="auth-reveal"><span className="auth-success-mark"><ShieldIcon /></span><p className="mt-8 text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Cuenta lista</p><h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-[var(--auth-text)]">Contraseña configurada.</h2><p className="mt-4 max-w-sm text-[0.95rem] leading-7 text-slate-600">Tu cuenta ya está preparada. Ahora puedes volver al inicio de sesión con tu nueva contraseña.</p><button className="auth-primary-button mt-8" type="button" onClick={onBack}><ArrowRightIcon /><span>Ir a iniciar sesión</span></button></div> : <><div className="auth-reveal"><button className="auth-back-button" type="button" onClick={onBack}><ArrowLeftIcon />Volver al inicio de sesión</button><p className="mt-10 text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Configuración segura</p><h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-[var(--auth-text)] sm:text-4xl">Activa tu cuenta.</h2><p className="mt-4 max-w-sm text-[0.95rem] leading-7 text-slate-600">Usa el código de un solo uso que te entregó el administrador.</p></div><form className="auth-reveal auth-reveal-delay mt-8 space-y-5" onSubmit={submit} noValidate><div><label className="text-sm font-semibold text-[var(--auth-text)]" htmlFor="activation-identifier">Usuario o correo</label><input id="activation-identifier" className="auth-input mt-2" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" required /></div><div><label className="text-sm font-semibold text-[var(--auth-text)]" htmlFor="activation-code">Código de activación</label><input id="activation-code" className="auth-input mt-2 font-mono tracking-[0.18em]" value={activationCode} onChange={(event) => setActivationCode(event.target.value)} placeholder="XXXX-XXXX" autoComplete="one-time-code" required /></div><div><label className="text-sm font-semibold text-[var(--auth-text)]" htmlFor="activation-password">Nueva contraseña</label><div className="relative mt-2"><input id="activation-password" className="auth-input pr-12" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /><button className="absolute right-3 top-1/2 flex -translate-y-1/2 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-[var(--auth-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--auth-focus)]" type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{showPassword ? <EyeOffIcon /> : <EyeIcon />}</button></div><p className="mt-2 text-xs leading-5 text-slate-500">Mínimo 12 caracteres, con al menos una letra y un número.</p></div><div><label className="text-sm font-semibold text-[var(--auth-text)]" htmlFor="activation-confirmation">Repite la contraseña</label><input id="activation-confirmation" className="auth-input mt-2" type={showPassword ? 'text' : 'password'} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required /></div>{error && <p className="flex items-start gap-3 rounded-xl border border-[var(--auth-danger)]/25 bg-[var(--auth-danger)]/10 px-4 py-3 text-sm leading-6 text-[#9c3342]" role="alert"><ShieldIcon className="mt-0.5 shrink-0" /> <span>{error}</span></p>}<button className="auth-primary-button" type="submit" disabled={busy}>{busy ? <Spinner /> : <ShieldIcon />}<span>{busy ? 'Activando cuenta…' : 'Configurar contraseña'}</span>{!busy && <ArrowRightIcon />}</button></form></>}</div></section></div></main>;
}

function AuthHeader() { return <header className="auth-header"><BrandMark /><div className="auth-theme-control"><ThemeSwitcher /></div></header>; }

function BrandMark() { return <div className="auth-brand"><span className="auth-brand-mark"><InventoryMark /></span><span className="auth-brand-copy"><strong>Inventory <span>TI</span></strong><small>Soporte TI · Chilexpress</small></span></div>; }
function InventoryIllustration() { return <svg className="auth-inventory-illustration" viewBox="0 0 380 230" fill="none" aria-hidden="true" focusable="false"><path className="auth-illustration-guide" d="M28 181h324M190 21v184M57 57l271 149M323 58 57 205" /><path className="auth-illustration-trail" d="m35 159 78 44 76-43 74 43 77-44" /><g className="auth-illustration-secondary"><path d="m42 86 53-30 53 30v63l-53 31-53-31V86Z" /><path d="m42 86 53 31 53-31M95 117v63" /><path d="m230 86 53-30 53 30v63l-53 31-53-31V86Z" /><path d="m230 86 53 31 53-31M283 117v63" /></g><g className="auth-illustration-primary"><path d="m125 66 64-37 64 37v76l-64 37-64-37V66Z" /><path d="m125 66 64 37 64-37M189 103v76M157 48l64 37v25" /><path d="m143 111 25 14m-25-3 17 10" /></g><circle cx="35" cy="159" r="4" fill="currentColor" /><circle cx="340" cy="159" r="4" fill="currentColor" /></svg>; }
function Icon({ children, className = '' }: { children: ReactNode; className?: string }) { return <svg className={`h-5 w-5 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>; }
function InventoryMark() { return <Icon className="h-6 w-6"><path d="m4 8 8-4 8 4v8l-8 4-8-4V8Z" /><path d="m4 8 8 4 8-4M12 12v8" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></Icon>; }
function ShieldIcon({ className = '' }: { className?: string }) { return <Icon className={className}><path d="M12 3 19 6v5c0 4.6-2.8 8-7 10-4.2-2-7-5.4-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></Icon>; }
function UserIcon({ className = '' }: { className?: string }) { return <Icon className={className}><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></Icon>; }
function LockIcon({ className = '' }: { className?: string }) { return <Icon className={className}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Icon>; }
function EyeIcon() { return <Icon><path d="M2.5 12s3.2-5 9.5-5 9.5 5 9.5 5-3.2 5-9.5 5-9.5-5-9.5-5Z" /><circle cx="12" cy="12" r="2" /></Icon>; }
function EyeOffIcon() { return <Icon><path d="m3 3 18 18M10.6 6.9A10.6 10.6 0 0 1 12 7c6.3 0 9.5 5 9.5 5a17.5 17.5 0 0 1-3.1 3.4M6.2 6.2C3.8 7.6 2.5 10 2.5 12c0 0 3.2 5 9.5 5 1.4 0 2.6-.3 3.7-.7" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Icon>; }
function ArrowRightIcon() { return <Icon><path d="M5 12h13M13 6l6 6-6 6" /></Icon>; }
function ArrowLeftIcon() { return <Icon><path d="M19 12H6M11 6l-6 6 6 6" /></Icon>; }
function Spinner() { return <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--auth-ink)]/25 border-t-[var(--auth-ink)]" aria-hidden="true" />; }

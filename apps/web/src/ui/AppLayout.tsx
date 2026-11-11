import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { canViewCatalog, canViewCorrections, canViewInventory, canViewUsers, type AppRole } from '../lib/permissions';
import { PageShell } from './PageShell';
import { useRequestError } from './feedback/useRequestError';
import { LoadingState } from './feedback/LoadingState';
import { RouteErrorBoundary } from './feedback/RouteErrorBoundary';
import { ThemeSwitcher } from './ThemeSwitcher';
import { useAuth, type AuthUser } from '../features/auth/auth-context';

const roleNames: Record<AuthUser['role'], string> = {
  JEFE: 'Jefe',
  COORDINADOR: 'Coordinador',
  SOPORTE: 'Soporte'
};

const routeTitles: Record<string, string> = {
  '/': 'Inicio',
  '/catalog': 'Catálogo',
  '/inventory': 'Inventario',
  '/inventory/imports': 'Revisión de importaciones',
  '/corrections': 'Correcciones',
  '/users': 'Usuarios',
  '/account': 'Mi cuenta'
};

const routeOrder = ['/', '/catalog', '/inventory', '/inventory/imports', '/corrections', '/users', '/account'];

const navigation: Array<{ to: string; label: string; icon: ReactNode; end?: boolean; canView: (role: AppRole) => boolean }> = [
  { to: '/', label: 'Inicio', icon: <HomeIcon />, end: true, canView: () => true },
  { to: '/catalog', label: 'Catálogo', icon: <CatalogIcon />, canView: canViewCatalog },
  { to: '/inventory', label: 'Inventario', icon: <ActivityIcon />, canView: canViewInventory },
  { to: '/corrections', label: 'Correcciones', icon: <CorrectionIcon />, canView: canViewCorrections },
  { to: '/users', label: 'Usuarios', icon: <UsersIcon />, canView: canViewUsers }
];
export function AppLayout() {
  const { user, logout } = useAuth();
  const reportError = useRequestError();
  const location = useLocation();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const previousRouteRef = useRef(location.pathname);
  const [routeDirection, setRouteDirection] = useState<'forward' | 'backward'>('forward');

  useEffect(() => {
    document.title = `${routeTitles[location.pathname] ?? 'Página no encontrada'} — Inventory TI`;
  }, [location.pathname]);
  useLayoutEffect(() => {
    const previousIndex = routeOrder.indexOf(previousRouteRef.current);
    const currentIndex = routeOrder.indexOf(location.pathname);
    setRouteDirection(currentIndex >= previousIndex ? 'forward' : 'backward');
    previousRouteRef.current = location.pathname;
  }, [location.pathname]);

  if (!user) return null;

  async function handleLogout() {
    setLogoutError(null);
    setIsLoggingOut(true);
    try {
      await logout();
    } catch (caughtError) {
      setLogoutError(reportError(caughtError, 'No se pudo cerrar la sesión'));
      setIsLoggingOut(false);
    }
  }

  return (
    <PageShell>
      <div className="app-shell">
        <aside className="app-sidebar" aria-label="Navegación de Inventory TI">
          <NavLink className="app-sidebar-brand" to="/" aria-label="Ir al inicio de Inventory TI">
            <span className="app-brand-mark"><InventoryMark /></span>
            <span className="app-brand-copy"><strong>Inventory <b>TI</b></strong><small>Control operativo</small></span>
          </NavLink>
          <div className="app-sidebar-heading">Espacio de trabajo</div>
          <nav className="app-navigation" aria-label="Navegación principal">
            {navigation.filter((item) => item.canView(user.role)).map((item) => <NavLink aria-label={item.label} title={item.label} className={({ isActive }) => `app-nav-link${isActive ? ' app-nav-link-active' : ''}`} end={item.end} key={item.to} to={item.to}>
              <span className="app-nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>)}
          </nav>
          <div className="app-sidebar-spacer" />
          <div className="app-sidebar-status"><span className="app-sidebar-status-dot" aria-hidden="true" /><span><strong>Servicio activo</strong><small>Sesión protegida</small></span></div>
          <NavLink className="app-sidebar-user" to="/account" aria-label="Abrir Mi cuenta"><span className="app-account-avatar" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span><span className="app-account-copy"><strong>{user.displayName}</strong><small>{roleNames[user.role]}</small></span></NavLink>
          <button className="app-sidebar-logout" type="button" onClick={() => void handleLogout()} disabled={isLoggingOut} aria-busy={isLoggingOut}><LogoutIcon /><span>{isLoggingOut ? 'Cerrando sesión' : 'Cerrar sesión'}</span></button>
        </aside>
        <div className="app-shell-main">
          <header className="app-shell-header">
            <div className="app-shell-header-inner">
              <NavLink className="app-mobile-brand" to="/" aria-label="Ir al inicio de Inventory TI">
                <span className="app-brand-mark"><InventoryMark /></span>
                <span>Inventory <b>TI</b></span>
              </NavLink>
              <div className="app-top-context"><span>Módulo actual</span><strong>{routeTitles[location.pathname] ?? 'Vista'}</strong></div>
              <div className="app-account">
                <ThemeSwitcher />
                <div className="app-mobile-account">
                  <NavLink className="app-account-profile" to="/account" aria-label="Abrir Mi cuenta"><span className="app-account-avatar" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span></NavLink>
                  <button className="app-mobile-logout" type="button" onClick={() => void handleLogout()} disabled={isLoggingOut} aria-busy={isLoggingOut} aria-label={isLoggingOut ? 'Cerrando sesión' : 'Cerrar sesión'}><LogoutIcon /></button>
                </div>
              </div>
            </div>
          </header>
          {logoutError && <div className="app-shell-alert" role="alert"><AlertIcon /><span>{logoutError}</span></div>}
          <main className="app-shell-content"><div key={location.pathname} className={"app-route-transition app-route-transition-" + routeDirection + (location.pathname === "/corrections" ? "" : " operational-route")}><RouteErrorBoundary><Suspense fallback={<LoadingState label="Cargando vista…" />}><Outlet /></Suspense></RouteErrorBoundary></div></main>
          <nav className="app-mobile-navigation" aria-label="Navegación principal móvil">
            {navigation.filter((item) => item.canView(user.role)).map((item) => <NavLink aria-label={item.label} title={item.label} className={({ isActive }) => `app-nav-link${isActive ? ' app-nav-link-active' : ''}`} end={item.end} key={item.to} to={item.to}>
              <span className="app-nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>)}
            <NavLink aria-label="Mi cuenta" title="Mi cuenta" className={({ isActive }) => `app-nav-link${isActive ? ' app-nav-link-active' : ''}`} to="/account">
              <span className="app-nav-icon"><AccountIcon /></span>
              <span>Cuenta</span>
            </NavLink>
          </nav>
        </div>
      </div>
    </PageShell>
  );
}

function AppIcon({ children, className = '' }: { children: ReactNode; className?: string }) { return <svg className={`h-5 w-5 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>; }
function InventoryMark() { return <AppIcon className="size-6"><path d="m4 8 8-4 8 4v8l-8 4-8-4V8Z" /><path d="m4 8 8 4 8-4M12 12v8" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></AppIcon>; }
function HomeIcon() { return <AppIcon><path d="m4 11 8-7 8 7" /><path d="M6 10v10h12V10M10 20v-6h4v6" /></AppIcon>; }
function CatalogIcon() { return <AppIcon><path d="m4 7 8-4 8 4v10l-8 4-8-4V7Z" /><path d="m4 7 8 4 8-4M12 11v10" /></AppIcon>; }
function ActivityIcon() { return <AppIcon><path d="M3 12h4l2.2-6 4.1 12L16 12h5" /></AppIcon>; }
function CorrectionIcon() { return <AppIcon><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h5M8 16h4" /></AppIcon>; }
function UsersIcon() { return <AppIcon><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 4 5" /></AppIcon>; }
function AccountIcon() { return <AppIcon><circle cx="12" cy="8" r="3.25" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></AppIcon>; }
function LogoutIcon() { return <AppIcon><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" /></AppIcon>; }
function AlertIcon() { return <AppIcon><path d="M12 4 21 20H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></AppIcon>; }

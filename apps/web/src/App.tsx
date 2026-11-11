import { lazy } from 'react';
import { AuthProvider, LoginPage } from './features/auth/auth';
import { useAuth } from './features/auth/auth-context';
import { ToastProvider } from './ui';
import { canViewUsers } from './lib/permissions';
import { AppLayout } from './ui/AppLayout';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';

const HomePage = lazy(() => import('./features/home/HomePage').then((module) => ({ default: module.HomePage })));
const CatalogPage = lazy(() => import('./features/home/CatalogPage').then((module) => ({ default: module.CatalogPage })));
const InventoryPage = lazy(() => import('./features/home/InventoryPage').then((module) => ({ default: module.InventoryPage })));
const ImportReviewPage = lazy(() => import('./features/imports/ImportReviewPage').then((module) => ({ default: module.ImportReviewPage })));
const CorrectionsPage = lazy(() => import('./features/home/CorrectionsPage').then((module) => ({ default: module.CorrectionsPage })));
const UsersPage = lazy(() => import('./features/admin/UsersPage').then((module) => ({ default: module.UsersPage })));
const ForbiddenPage = lazy(() => import('./features/admin/UsersPage').then((module) => ({ default: module.ForbiddenPage })));
const AccountPage = lazy(() => import('./features/auth/AccountPage').then((module) => ({ default: module.AccountPage })));

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <AuthenticatedApp />
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

function AuthenticatedApp() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <main className="app-loading">Cargando sesión…</main>;
  }

  if (!user) return <LoginPage />;

  return <Routes>
    <Route element={<AppLayout />}>
      <Route path="/" element={<HomePage />} />
      <Route path="/catalog" element={<CatalogPage />} />
      <Route path="/inventory" element={<InventoryPage />} />
      <Route path="/inventory/imports" element={<ImportReviewPage />} />
      <Route path="/corrections" element={<CorrectionsPage />} />
      <Route path="/users" element={canViewUsers(user.role) ? <UsersPage /> : <ForbiddenPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes>;
}

function NotFoundPage() {
  return <section className="app-page"><div className="app-panel max-w-2xl"><p className="app-page-kicker">Ruta no encontrada</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">Esta vista no existe.</h1><p className="mt-3 leading-7 text-slate-600 dark:text-slate-400">La dirección puede estar desactualizada o la sección todavía no está disponible.</p><Link className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-sky-600 px-4 font-semibold text-white transition hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2" to="/">Volver al inicio</Link></div></section>;
}

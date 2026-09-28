import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { apiRequest } from '../../lib/api';
import { useToast, useRequestError } from '../../ui';

type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'RESERVED' | 'UNDER_REVIEW' | 'IN_REPAIR' | 'IN_WARRANTY' | 'LOST' | 'DECOMMISSIONED';
type AssetSummary = { id: string; status: AssetStatus; assetTag: string | null; serialNumber: string | null; product: { name: string } };
type Person = { id: string; username: string; displayName: string; isActive: boolean };
type Assignment = {
  id: string;
  assetId: string;
  personId: string;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  person: Person;
  createdBy: Person;
  endedBy: Person | null;
};

const request = apiRequest;

async function mutate<T>(path: string, body?: unknown): Promise<T> {
  const { csrfToken } = await request<{ csrfToken: string }>('/auth/csrf');
  return request<T>(path, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function personName(person: Person | null | undefined) {
  return person ? `${person.displayName} (@${person.username})` : '—';
}

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString('es-CL') : 'Activa';
}

export function AssignmentPanel({ asset, close, saved }: { asset: AssetSummary; close: () => void; saved: () => void }) {
  const { showToast } = useToast();
  const reportError = useRequestError();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [current, setCurrent] = useState<Assignment | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [personId, setPersonId] = useState('');
  const [personSearch, setPersonSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<globalThis.HTMLDialogElement>(null);

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await request<{ assignments: Assignment[]; currentAssignment: Assignment | null }>(`/assets/${asset.id}/assignments?limit=50`);
      setAssignments(result.assignments);
      setCurrent(result.currentAssignment);
    } catch (caughtError) {
      setError(reportError(caughtError, 'No se pudo cargar el historial'));
    } finally {
      setLoading(false);
    }
  }, [asset.id, reportError]);

  useEffect(() => { void loadAssignments(); }, [loadAssignments]);

  useEffect(() => {
    if (asset.status !== 'AVAILABLE') return undefined;
    let cancelled = false;
    const timer = globalThis.setTimeout(async () => {
      setSearching(true);
      try {
        const query = new globalThis.URLSearchParams({ limit: '50' });
        if (personSearch.trim()) query.set('search', personSearch.trim());
        const result = await request<{ users: Person[] }>(`/assignment-users?${query}`);
        if (!cancelled) setPeople(result.users);
      } catch (caughtError) {
        if (!cancelled) setError(reportError(caughtError, 'No se pudieron cargar las personas'));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; globalThis.clearTimeout(timer); };
  }, [asset.status, personSearch, reportError]);

  useEffect(() => {
    const previous = globalThis.document.activeElement instanceof globalThis.HTMLElement ? globalThis.document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    return () => { if (dialog.open) dialog.close(); previous?.focus(); };
  }, []);

  async function assign(event: FormEvent) {
    event.preventDefault();
    if (!personId) return;
    setSaving(true);
    setError(null);
    try {
      await mutate(`/assets/${asset.id}/assignments`, { personId });
      saved();
      const person = people.find((candidate) => candidate.id === personId);
      showToast({
        tone: 'success',
        title: 'Activo asignado',
        description: `${asset.assetTag ?? asset.serialNumber ?? asset.product.name} quedó asignado a ${person?.displayName ?? 'la persona seleccionada'}.`
      });
    } catch (caughtError) {
      setError(reportError(caughtError, 'No se pudo asignar el activo'));
    } finally {
      setSaving(false);
    }
  }

  async function returnAsset() {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      await mutate(`/assets/${asset.id}/assignments/${current.id}/return`);
      saved();
      showToast({
        tone: 'success',
        title: 'Activo devuelto',
        description: `${asset.assetTag ?? asset.serialNumber ?? asset.product.name} volvió a estar disponible.`
      });
    } catch (caughtError) {
      setError(reportError(caughtError, 'No se pudo devolver el activo'));
    } finally {
      setSaving(false);
    }
  }

  const canAssign = asset.status === 'AVAILABLE' && !current;
  const canReturn = asset.status === 'ASSIGNED' && current;

  return (
    <dialog ref={dialogRef} tabIndex={-1} className="m-auto max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl outline-none backdrop:bg-slate-950/60 dark:bg-slate-900" aria-labelledby="assignment-panel-title" onCancel={(event) => { event.preventDefault(); close(); }}>
        <div className="mb-5 flex items-start justify-between gap-3">
          <div><p className="text-sm font-semibold uppercase tracking-[0.15em] text-sky-600 dark:text-sky-400">Asignaciones</p><h2 id="assignment-panel-title" className="mt-1 text-xl font-bold">{asset.assetTag ?? asset.serialNumber ?? 'Activo'}</h2><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{asset.product.name}</p></div>
          <button className="rounded px-2 text-2xl" type="button" aria-label="Cerrar asignaciones" onClick={close}>×</button>
        </div>

        {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300" role="alert">{error}</p>}
        {loading ? <p className="rounded-xl border border-dashed p-5 text-sm text-slate-500" role="status">Cargando historial…</p> : <AssignmentContent current={current} assignments={assignments} canAssign={canAssign} canReturn={Boolean(canReturn)} people={people} personId={personId} personSearch={personSearch} searching={searching} saving={saving} confirmReturn={confirmReturn} setPersonId={setPersonId} setPersonSearch={setPersonSearch} setConfirmReturn={setConfirmReturn} assign={assign} returnAsset={returnAsset} />}
        <div className="mt-6 flex justify-end"><button className="rounded-lg border px-4 py-2" type="button" onClick={close}>Cerrar</button></div>
      </dialog>
  );
}

function AssignmentDetail({ label, value }: { label: string; value: string }) { return <div><dt className="font-medium text-slate-500">{label}</dt><dd className="mt-1">{value}</dd></div>; }

function AssignmentContent({ current, assignments, canAssign, canReturn, people, personId, personSearch, searching, saving, confirmReturn, setPersonId, setPersonSearch, setConfirmReturn, assign, returnAsset }: { current: Assignment | null; assignments: Assignment[]; canAssign: boolean; canReturn: boolean; people: Person[]; personId: string; personSearch: string; searching: boolean; saving: boolean; confirmReturn: boolean; setPersonId: (value: string) => void; setPersonSearch: (value: string) => void; setConfirmReturn: (value: boolean) => void; assign: (event: FormEvent) => void; returnAsset: () => void }) {
  return <>
    <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-700" aria-labelledby="current-assignment-title">
      <h3 id="current-assignment-title" className="font-semibold">Asignación actual</h3>
      {current ? <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><AssignmentDetail label="Persona" value={personName(current.person)} /><AssignmentDetail label="Inicio" value={dateLabel(current.startedAt)} /><AssignmentDetail label="Registrada por" value={personName(current.createdBy)} /></dl> : <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">No hay una asignación activa.</p>}
    </section>
    {canAssign && <form className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700" noValidate onSubmit={assign}>
      <h3 className="font-semibold">Asignar activo</h3>
      <label className="mt-3 block text-sm font-medium" htmlFor="assignment-person-search">Buscar persona<input id="assignment-person-search" className="field" value={personSearch} onChange={(event) => setPersonSearch(event.target.value)} placeholder="Nombre o usuario" autoComplete="off" /></label>
      <label className="mt-3 block text-sm font-medium" htmlFor="assignment-person">Persona<select id="assignment-person" className="field" required value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">{searching ? 'Buscando…' : 'Selecciona una persona'}</option>{people.map((person) => <option key={person.id} value={person.id}>{personName(person)}</option>)}</select></label>
      <div className="mt-4 flex justify-end"><button className="rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white disabled:opacity-50" type="submit" disabled={saving || !personId}>{saving ? 'Asignando…' : 'Asignar'}</button></div>
    </form>}
    {canReturn && <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/20"><h3 className="font-semibold">Devolver activo</h3><p className="mt-2 text-sm text-amber-900 dark:text-amber-200">La devolución cerrará la asignación y dejará el activo disponible.</p>{confirmReturn ? <div className="mt-4 flex justify-end gap-2"><button className="rounded-lg border px-4 py-2" type="button" onClick={() => setConfirmReturn(false)}>Cancelar</button><button className="rounded-lg bg-amber-700 px-4 py-2 font-semibold text-white disabled:opacity-50" type="button" disabled={saving} onClick={() => returnAsset()}>{saving ? 'Devolviendo…' : 'Confirmar devolución'}</button></div> : <div className="mt-4 flex justify-end"><button className="rounded-lg bg-amber-700 px-4 py-2 font-semibold text-white" type="button" onClick={() => setConfirmReturn(true)}>Devolver</button></div>}</section>}
    <section className="mt-5" aria-labelledby="assignment-history-title"><h3 id="assignment-history-title" className="font-semibold">Historial</h3>{assignments.length === 0 ? <p className="mt-2 text-sm text-slate-500">Aún no hay asignaciones registradas.</p> : <div className="mt-3 space-y-3">{assignments.map((assignment) => <article className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700" key={assignment.id}><p className="font-medium">{personName(assignment.person)}</p><p className="mt-1 text-slate-600 dark:text-slate-300">{dateLabel(assignment.startedAt)} → {dateLabel(assignment.endedAt)}</p>{assignment.endedAt && <p className="mt-1 text-slate-500">Devuelta por {personName(assignment.endedBy)}</p>}</article>)}</div>}</section>
  </>;
}

import { useRef, useState } from 'react';
import { Button, ModuleFilters } from '../../ui';
import { environment } from '../../config/environment';
import { useAuth } from '../auth/auth-context';
import type { ImportPreview } from './import-review-model';
import { IdentityGroupPlanDialog } from './IdentityGroupPlanDialog';
import { IdentityGroupReviewsDialog } from './IdentityGroupReviewsDialog';

export function IdentityGroupPanel({ batchId, original, disabled }: { batchId: string; original: ImportPreview; disabled: boolean }) {
  const [snapshot, setSnapshot] = useState<ImportPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'plan' | 'reviews' | null>(null);
  const { user } = useAuth();
  const trigger = useRef<globalThis.HTMLButtonElement | null>(null);
  return <section aria-label="Revisión de agrupaciones físicas">
    <ModuleFilters className="catalog-toolbar" ariaLabel="Controles de agrupación">{environment.inventoryImportIdentityGroupsV16 && <Button variant="secondary" disabled={disabled} onClick={(event) => { trigger.current = event.currentTarget; setSnapshot(original); setView('plan'); setOpen(true); }}>Simular agrupación física</Button>}{environment.inventoryImportIdentityGroupReviewsV17 && <Button variant="secondary" disabled={disabled} onClick={(event) => { trigger.current = event.currentTarget; setSnapshot(original); setView('reviews'); setOpen(true); }}>Consultar revisiones de agrupación</Button>}</ModuleFilters>
    {snapshot && view === 'plan' && <IdentityGroupPlanDialog key={batchId + ':' + user?.id} batchId={batchId} original={snapshot} open={open} close={() => setOpen(false)} exited={() => { setSnapshot(null); setView(null); trigger.current?.focus({ preventScroll: true }); }} />}
    {snapshot && view === 'reviews' && user && <IdentityGroupReviewsDialog key={batchId + ':' + user.id} batchId={batchId} actorId={user.id} original={snapshot} open={open} close={() => setOpen(false)} exited={() => { setSnapshot(null); setView(null); trigger.current?.focus({ preventScroll: true }); }} />}
  </section>;
}

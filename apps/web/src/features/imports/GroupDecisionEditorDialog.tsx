import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, Field, LoadingState, Select } from '../../ui';
import { groupDecisionLabels, groupDecisionOptions, groupEvidenceLabels, emptyGroupDecision, validateGroupDecisionDraft, type GroupDecisionDraft } from './identity-group-decision-model';
import type { IdentityGroupProjection } from './identity-group-projection-model';
import type { IdentityGroupReview } from './identity-group-review-model';
import { GroupDecisionDetails } from './GroupDecisionDetails';
import { IdentityGroupResultTable } from './IdentityGroupPlanDetails';
import { SourceFields } from './SourceEvidence';
import { useGroupDecisionContext } from './useGroupDecisionContext';
import { useGroupDecisionMutation } from './useGroupDecisionMutation';

export function GroupDecisionEditorDialog({ review, actorId, initial, groupKey, open, close, exited, back }: {
  review: IdentityGroupReview; actorId: string; initial: IdentityGroupProjection; groupKey: string; open: boolean; close: () => void; exited: () => void; back: (refresh: boolean) => void;
}) {
  const query = useGroupDecisionContext(review, initial, open);
  const mutation = useGroupDecisionMutation(review, actorId);
  const [draft, setDraft] = useState(emptyGroupDecision); const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false); const [confirmed, setConfirmed] = useState(false); const [selectedEvidence, setSelectedEvidence] = useState('');
  const [discard, setDiscard] = useState<'close' | 'back' | null>(null); const paused = useRef(false);
  const content = useRef<globalThis.HTMLDivElement>(null); const form = useRef<globalThis.HTMLFormElement>(null);
  const context = query.data;
  const options = groupDecisionOptions(context?.projection ?? initial, groupKey, context?.latest.items);
  const group = options.group;
  const dirty = Boolean(draft.action || draft.note || draft.reference || draft.reviewEvidence || Object.keys(draft.evidence).length || mutation.uncertain);
  const disabled = query.reading || !query.fresh || mutation.locked || Boolean(discard);
  const needsEvidence = ['LINK_EXISTING', 'PROPOSE_NEW'].includes(draft.action) || draft.reviewEvidence;
  const evidence = group?.evidence.find((row) => row.id === selectedEvidence) ?? group?.evidence[0];
  const latest = context?.latest.items.find((row) => row.groupKey === groupKey);
  useEffect(() => {
    if (!dirty || mutation.saved) return;
    const warn = (event: globalThis.BeforeUnloadEvent) => event.preventDefault(); globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [dirty, mutation.saved]);
  useEffect(() => {
    if (!open) return;
    const frame = globalThis.requestAnimationFrame(() => content.current?.closest('dialog')?.querySelector<globalThis.HTMLElement>(
      discard ? '[data-decision-keep]' : query.error || mutation.error ? '[data-decision-error]' : mutation.saved ? '[data-group-decision-receipt]' : confirming ? '[data-decision-edit]' : '[data-decision-context]')?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [open, discard, query.error, mutation.error, mutation.saved, confirming, query.data]);
  function update(patch: Partial<GroupDecisionDraft>) {
    if (disabled || paused.current || !open) return;
    setDraft((current) => ({ ...current, ...patch })); setErrors({}); setConfirmed(false);
  }
  function updateEvidence(id: string, patch: Partial<GroupDecisionDraft['evidence'][string]>) {
    if (disabled || paused.current || !open) return;
    setDraft((current) => ({ ...current, evidence: { ...current.evidence, [id]: { ...(current.evidence[id] ?? { disposition: '', note: '', reference: '' }), ...patch } } })); setErrors({}); setConfirmed(false);
  }
  function leave(destination: 'close' | 'back') {
    if (mutation.submitting()) return;
    if (dirty && !mutation.saved) { paused.current = true; setDiscard(destination); }
    else if (destination === 'back') back(Boolean(mutation.saved) || mutation.needsContext); else close();
  }
  async function reload() {
    if (mutation.blocked() || query.reading || discard || paused.current || !open) return;
    setConfirmed(false); setConfirming(false); setErrors({});
    const result = await query.refresh();
    if (result) {
      mutation.reviewed();
      setDraft((current) => ({ ...current, evidence: Object.fromEntries(Object.entries(current.evidence).map(([id, value]) => [id, { ...value, disposition: '' }])) }));
    }
  }
  function prepare(event: FormEvent) {
    event.preventDefault(); if (!open || paused.current || disabled || confirming || mutation.needsContext || !context) return;
    const next = validateGroupDecisionDraft(context, groupKey, draft); setErrors(next);
    if (Object.keys(next).length) {
      const invalidEvidence = group?.evidence.find((row) => Object.keys(next).some((key) => key.startsWith(row.id + '.'))); if (invalidEvidence) setSelectedEvidence(invalidEvidence.id);
      globalThis.requestAnimationFrame(() => form.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]')?.focus()); return;
    }
    setConfirmed(false); setConfirming(true);
  }
  async function save() {
    if (!open || paused.current || discard || mutation.submitting()) return;
    if (!mutation.uncertain && (!confirming || !confirmed || !query.fresh || query.reading || mutation.needsContext || !context)) return;
    await mutation.save(mutation.uncertain ? undefined : context!, groupKey, draft);
  }
  return <Dialog className="catalog-editor-dialog import-review-dialog" title={mutation.saved ? 'Decisión guardada' : 'Decidir grupo'} description="Registra una intención administrativa. El inventario y la evidencia no se modifican." open={open} busy={mutation.busy} onClose={() => leave('close')} onExited={exited} actions={discard ? <><Button key="keep-decision" data-decision-keep variant="secondary" onClick={() => { paused.current = false; setDiscard(null); }}>Seguir revisando</Button><Button key="discard-decision" onClick={() => discard === 'back' ? back(true) : close()}>Descartar y salir</Button></> : mutation.saved ? <><Button key="done-group-decision" variant="secondary" onClick={() => back(true)}>Volver al grupo</Button><Button key="close-group-decision" variant="secondary" onClick={close}>Cerrar</Button></> : <><Button key="back-from-group-decision" variant="secondary" disabled={mutation.busy} onClick={() => leave('back')}>Volver al grupo</Button>{confirming && !mutation.uncertain && <Button key="edit-group-decision" data-decision-edit variant="secondary" disabled={mutation.locked} onClick={() => { setConfirming(false); setConfirmed(false); }}>Volver a editar</Button>}{mutation.uncertain || confirming ? <Button key="save-group-decision" loading={mutation.busy} disabled={!mutation.uncertain && (!confirmed || !query.fresh || mutation.needsContext)} onClick={() => void save()}>{mutation.uncertain ? 'Recuperar mismo intento' : 'Guardar decisión'}</Button> : <Button key="prepare-group-decision" type="submit" form="group-decision-form" disabled={disabled || mutation.needsContext}>Revisar decisión</Button>}</>}>
    <div ref={content} className="space-y-4">
      {discard && <Alert variant="warning">{mutation.uncertain ? 'La decisión pudo guardarse. Salir pierde la intención en memoria y no revierte el servidor. Consulta los comprobantes antes de iniciar otra decisión.' : 'Se perderá este borrador de decisión y sus revisiones de evidencia.'}</Alert>}
      <div data-decision-error tabIndex={-1} className="space-y-3">{query.error && <Alert variant="danger">{query.error}{context && ' El contexto anterior no confirma vigencia.'}</Alert>}{errors.context && <Alert variant="danger">{errors.context}</Alert>}{mutation.error && <Alert variant="danger">{mutation.error}</Alert>}{mutation.needsContext && <Alert variant="warning">Actualiza el contexto y revisa nuevamente la decisión. La confirmación anterior quedó invalidada.</Alert>}</div>
      {!mutation.saved && <Button variant="secondary" size="sm" loading={query.reading} disabled={mutation.locked || Boolean(discard)} onClick={() => void reload()}>Actualizar contexto</Button>}
      {query.reading && <LoadingState label="Confirmando proyección y versión global de decisiones…" />}
      {mutation.uncertain && <Alert variant="warning"><p>Resultado sin confirmar. Recupera la misma clave y el mismo contenido; no cambies la decisión ni actualices su contexto.</p><p className="break-words">Clave: {mutation.requestId}</p></Alert>}
      {mutation.saved ? <GroupDecisionDetails decision={mutation.saved.decision} /> : group && <>
        <div className="inventory-asset-editor-summary"><div><strong>{group.serialNumber ?? group.assetTag}</strong><small>{group.recordIds.length} observaciones completas</small></div></div>
        <div data-decision-context tabIndex={-1} className="import-review-summary"><Badge variant="info">Versión global de decisiones: {context?.latest.decisionVersion ?? '—'}</Badge><Badge variant="neutral">{latest ? 'Última del grupo: ' + groupDecisionLabels[latest.action] : 'Sin decisión anterior de este grupo'}</Badge></div>
        {context && !query.fresh && <Alert variant="warning">Contexto sin vigencia confirmada. Se conserva el borrador; actualiza antes de revisar.</Alert>}
        <form id="group-decision-form" ref={form} noValidate onSubmit={prepare} className="space-y-4">
          <fieldset className="space-y-4 min-w-0" disabled={disabled} hidden={confirming}>
            <Field label="Decisión del grupo" required error={errors.action}><Select value={draft.action} onChange={(value) => update({ action: value as GroupDecisionDraft['action'], linkedAssetId: '', reviewEvidence: false })} options={[{ value: '', label: 'Seleccionar decisión' }, ...Object.entries(groupDecisionLabels).map(([value, label]) => ({ value, label, disabled: value === 'LINK_EXISTING' ? !options.canLink : value === 'PROPOSE_NEW' ? !options.canCreate : false }))]} /></Field>
            {(!options.canCreate || !options.canLink) && <p className="inventory-metadata-hint">Las propuestas operativas dependen de bloqueos, coincidencias completas y otros vínculos propuestos. Dejar pendiente o excluir no libera la reserva.</p>}
            {draft.action === 'LINK_EXISTING' && <Field label="Activo sugerido" required error={errors.linkedAssetId}><Select value={draft.linkedAssetId} onChange={(value) => update({ linkedAssetId: value })} options={[{ value: '', label: 'Seleccionar el activo sugerido' }, ...options.matches.map((asset) => ({ value: asset.id, label: asset.product.name + ' · ' + (asset.serialNumber ?? asset.assetTag ?? asset.id) }))]} /></Field>}
            <Field label="Motivo de la decisión" required error={errors.note}><textarea className="resize-none" rows={3} maxLength={2000} value={draft.note} onChange={(event) => update({ note: event.target.value })} /></Field>
            <Field label="Respaldo de la decisión" required error={errors.reference}><input autoComplete="off" maxLength={500} value={draft.reference} onChange={(event) => update({ reference: event.target.value })} /></Field>
            {group.evidence.length > 0 ? <section className="space-y-4" aria-label="Revisar pertenencia de evidencia">
              {!['LINK_EXISTING', 'PROPOSE_NEW'].includes(draft.action) && <Field label="Revisión de evidencia" error={errors.reviewEvidence}><Select value={draft.reviewEvidence ? 'review' : 'pending'} onChange={(value) => update({ reviewEvidence: value === 'review' })} options={[{ value: 'pending', label: 'Dejar las evidencias pendientes' }, { value: 'review', label: 'Revisar todas las evidencias del grupo', disabled: options.consumed }]} /></Field>}
              {options.consumed && <Alert variant="warning">Hay evidencia utilizada en historia aplicada. No se puede otorgar una nueva autoridad de pertenencia.</Alert>}
              {needsEvidence && <>
                <Field label="Evidencia a revisar"><Select searchable={group.evidence.length > 8} value={evidence?.id ?? ''} onChange={setSelectedEvidence} options={group.evidence.map((row, index) => { const source = group.observations.find((item) => item.recordId === row.recordId); return { value: row.id, label: 'Evidencia ' + (index + 1) + ' · ' + (source ? source.sheet + ' · fila ' + source.row : row.id) + ' · v' + row.evidenceVersion }; })} /></Field>
                <p className="inventory-metadata-hint">{group.evidence.filter((row) => { const value = draft.evidence[row.id]; return value?.disposition && value.note.trim() && value.reference.trim(); }).length} de {group.evidence.length} revisiones completas. Todas requieren una decisión explícita.</p>
                {evidence && <GroupEvidenceEditor key={evidence.id} evidence={evidence} source={group.observations.find((item) => item.recordId === evidence.recordId)} value={draft.evidence[evidence.id] ?? { disposition: '', note: '', reference: '' }} errors={errors} update={(patch) => updateEvidence(evidence.id, patch)} />}
              </>}
            </section> : <p className="inventory-metadata-hint">Sin evidencia archivada en este grupo; se enviará una lista de revisiones vacía.</p>}
          </fieldset>
        </form>
        {confirming && <section className="space-y-4" aria-label="Confirmar decisión administrativa">
          <h3 className="font-semibold">Revisar antes de guardar</h3><Badge variant="info">{groupDecisionLabels[draft.action as keyof typeof groupDecisionLabels]}</Badge>
          <dl className="inventory-metadata-detail"><div><dt>Motivo</dt><dd className="whitespace-pre-wrap">{draft.note}</dd></div><div><dt>Respaldo</dt><dd>{draft.reference}</dd></div><div><dt>Evidencia a decidir</dt><dd>{needsEvidence ? group.evidence.length : 0} elementos · {needsEvidence ? 'revisión completa' : 'sin otorgar pertenencia'}</dd></div>{draft.linkedAssetId && <div><dt>Activo propuesto</dt><dd>{draft.linkedAssetId}</dd></div>}</dl>
          <Alert variant="warning">Guardar sustituye la intención del grupo en «Últimas por grupo» y conserva el historial. No aplica inventario, libera filas ni cambia vínculos de evidencia.</Alert>
          {needsEvidence && <IdentityGroupResultTable rows={group.evidence} rowKey={(row) => row.id} caption="Revisiones de evidencia que se guardarán" columns={[
            { key: 'origin', header: 'Evidencia', mobileRole: 'identity', render: (row) => { const source = group.observations.find((item) => item.recordId === row.recordId); return <span className="break-words">{source ? source.sheet + ' · fila ' + source.row : row.id}<small className="block">Evidencia v{row.evidenceVersion} · {row.id}</small></span>; } },
            { key: 'decision', header: 'Pertenencia', mobileRole: 'full', render: (row) => <Badge variant="info">{groupEvidenceLabels[draft.evidence[row.id].disposition as keyof typeof groupEvidenceLabels]}</Badge> },
            { key: 'proof', header: 'Motivo y respaldo', mobileRole: 'full', render: (row) => <span className="break-words whitespace-pre-wrap">{draft.evidence[row.id].note}<small className="block">{draft.evidence[row.id].reference}</small></span> }
          ]} />}
          <Field label="Alcance del guardado" required disabled={mutation.locked}><Select value={confirmed ? 'confirmed' : ''} onChange={(value) => setConfirmed(value === 'confirmed')} options={[{ value: '', label: 'Sin confirmar' }, { value: 'confirmed', label: 'Revisé la decisión y sus evidencias. Guardar solo la decisión.' }]} /></Field>
        </section>}
      </>}
    </div>
  </Dialog>;
}

function GroupEvidenceEditor({ evidence, source, value, errors, update }: { evidence: IdentityGroupProjection['groups'][number]['evidence'][number]; source: IdentityGroupProjection['groups'][number]['observations'][number] | undefined; value: GroupDecisionDraft['evidence'][string]; errors: Record<string, string>; update: (patch: Partial<GroupDecisionDraft['evidence'][string]>) => void }) {
  return <section className="inventory-metadata-section space-y-4" aria-label="Decisión de una evidencia">
    <div className="import-review-summary">{source && <strong>{source.sheet} · fila {source.row}</strong>}<Badge variant="info">Evidencia v{evidence.evidenceVersion}</Badge></div>
    <dl className="inventory-metadata-detail"><div><dt>Vínculo al capturar</dt><dd>{evidence.capturedAssetId ?? 'Sin vínculo'}</dd></div><div><dt>Vínculo actual</dt><dd>{evidence.currentAssetId ?? 'Sin vínculo explícitamente'}</dd></div></dl>
    {source && <details><summary>Observación de origen consultada</summary><div className="mt-3"><SourceFields fields={source.fields} /></div><p className="inventory-metadata-hint">Es la interpretación del origen en esta consulta; no sustituye la captura histórica ni sus enmiendas.</p></details>}
    <details><summary>Referencias de captura y versiones</summary><dl className="inventory-metadata-detail mt-3"><div><dt>Evidencia / captura</dt><dd>{evidence.id} · {evidence.captureId}</dd></div><div><dt>Lote de captura / origen</dt><dd>{evidence.captureBatchId} · captura r{evidence.capturedSourceRevision} · interpretación r{evidence.sourceRevision}</dd></div><div><dt>Enmienda</dt><dd>{evidence.amendmentId ?? 'Sin enmienda'}</dd></div></dl></details>
    <Field label="Pertenencia de esta evidencia" required error={errors[evidence.id + '.disposition']}><Select value={value.disposition} onChange={(disposition) => update({ disposition: disposition as typeof value.disposition })} options={[{ value: '', label: 'Seleccionar disposición' }, ...Object.entries(groupEvidenceLabels).map(([value, label]) => ({ value, label }))]} /></Field>
    <Field label="Motivo de esta evidencia" required error={errors[evidence.id + '.note']}><textarea className="resize-none" rows={3} maxLength={2000} value={value.note} onChange={(event) => update({ note: event.target.value })} /></Field>
    <Field label="Respaldo de esta evidencia" required error={errors[evidence.id + '.reference']}><input autoComplete="off" maxLength={500} value={value.reference} onChange={(event) => update({ reference: event.target.value })} /></Field>
  </section>;
}

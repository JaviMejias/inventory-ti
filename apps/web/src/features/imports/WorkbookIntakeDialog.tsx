import { useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../../lib/api';
import { formatInventoryDateTime } from '../../lib/date-range';
import { Alert, Badge, Button, Dialog, Field, LoadingState, Select, useToast } from '../../ui';
import { ImportPreviewTables } from './ImportPreviewTables';
import { parseWorkbookJSON, workbookBodyLimit, type WorkbookInput } from './workbook-intake-model';
import { useWorkbookIntake } from './useWorkbookIntake';

export function WorkbookIntakeDialog({ open, close, exited, reviewBatch, changed }: { open: boolean; close: () => void; exited: () => void; reviewBatch: (id: string) => void; changed: () => void }) {
  const [workbook, setWorkbook] = useState<WorkbookInput | null>(null); const [fileName, setFileName] = useState(''); const [fileError, setFileError] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false); const [confirmed, setConfirmed] = useState(false); const [invalid, setInvalid] = useState(false); const [discard, setDiscard] = useState(false);
  const input = useRef<globalThis.HTMLInputElement>(null); const content = useRef<globalThis.HTMLDivElement>(null); const epoch = useRef(0); const active = useRef(true); const paused = useRef(false); const destination = useRef<string | null>(null);
  const workflow = useWorkbookIntake(); const { showToast } = useToast();
  const dirty = Boolean(workbook || workflow.uncertain);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (!dirty || workflow.saved) return; const warn = (event: globalThis.BeforeUnloadEvent) => event.preventDefault(); globalThis.addEventListener('beforeunload', warn); return () => globalThis.removeEventListener('beforeunload', warn); }, [dirty, workflow.saved]);
  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => {
      const selector = discard ? '[data-intake-keep]' : workflow.error || fileError ? '[data-intake-error]' : workflow.saved ? '[data-intake-saved]' : workflow.preview ? '[data-intake-preview]' : null;
      const target = selector ? content.current?.closest('dialog')?.querySelector<globalThis.HTMLElement>(selector) : null; target?.focus();
    }); return () => globalThis.cancelAnimationFrame(frame);
  }, [discard, workflow.error, fileError, workflow.saved, workflow.preview]);
  async function chooseFile(file: globalThis.File | undefined) {
    if (!file || workflow.blocked() || paused.current) return;
    const version = ++epoch.current; workflow.clear(); setWorkbook(null); setConfirmed(false); setFileError(null); setFileName(file.name); setReadingFile(true);
    try {
      if (!/\.json$/i.test(file.name) || file.size > workbookBodyLimit) throw new ApiRequestError('Selecciona un archivo .json del extractor de hasta 16 MiB.', 400, 'INVALID_WORKBOOK_INPUT');
      const text = await file.text(); if (!active.current || version !== epoch.current) return;
      setWorkbook(parseWorkbookJSON(text));
    } catch (caught) {
      if (active.current && version === epoch.current) {
        const message = caught instanceof ApiRequestError && caught.code === 'INVALID_WORKBOOK_INPUT' ? caught.message : 'No se pudo leer el archivo. Selecciona nuevamente la extracción JSON.';
        setFileError(message); showToast({ tone: 'error', title: 'Archivo de extracción no válido', description: message });
      }
    } finally { if (active.current && version === epoch.current) setReadingFile(false); }
  }
  function clearFile() { if (workflow.blocked()) return; epoch.current++; workflow.clear(); setWorkbook(null); setFileName(''); setFileError(null); setReadingFile(false); setConfirmed(false); if (input.current) { input.current.value = ''; input.current.focus(); } }
  function requestClose() { if (workflow.submitting()) return; if (workflow.saved) { close(); return; } paused.current = true; workflow.cancelRead(); if (dirty || readingFile) setDiscard(true); else close(); }
  async function generate() { if (!workbook || readingFile || discard || workflow.blocked() || !open || paused.current) return; setConfirmed(false); setInvalid(false); await workflow.generate(workbook); }
  async function save() {
    if (!open || paused.current || discard || workflow.submitting() || readingFile) return;
    if (!workflow.uncertain && (!workbook || workflow.needsPreview || !workflow.preview || workflow.reading)) return;
    if (!workflow.uncertain && !confirmed) { setInvalid(true); globalThis.requestAnimationFrame(() => content.current?.querySelector<globalThis.HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    const result = await workflow.save(workflow.uncertain ? undefined : workbook!); if (result) changed();
  }
  const disabled = readingFile || workflow.reading || workflow.locked || discard;
  return <Dialog className="catalog-editor-dialog import-review-dialog" open={open} busy={workflow.busy} onClose={requestClose} onExited={() => { const id = destination.current; exited(); if (id) reviewBatch(id); }} title={workflow.saved ? 'Lote de revisión guardado' : 'Nuevo lote de revisión'} description="Previsualiza la extracción y guarda su origen para revisión. Estos pasos no cargan activos ni movimientos." actions={discard ? <><Button key="keep-intake" data-intake-keep variant="secondary" onClick={() => { paused.current = false; setDiscard(false); }}>Seguir revisando</Button><Button key="discard-intake" onClick={close}>{workflow.uncertain ? 'Cerrar sin resolver el intento' : 'Descartar y cerrar'}</Button></> : workflow.saved ? <><Button key="close-created-batch" variant="secondary" onClick={requestClose}>Cerrar</Button><Button key="open-created-batch" onClick={() => { destination.current = workflow.saved!.id; close(); }}>Revisar lote</Button></> : <><Button key="close-intake" variant="secondary" disabled={workflow.busy} onClick={requestClose}>Cerrar</Button>{!workflow.uncertain && <Button key="generate-preview" variant={workflow.preview ? 'secondary' : 'primary'} disabled={disabled || !workbook} loading={workflow.reading} onClick={() => void generate()}>{workflow.preview ? 'Generar nuevamente' : 'Generar previsualización'}</Button>}{(workflow.preview || workflow.uncertain) && <Button key={workflow.uncertain ? 'recover-batch' : 'save-batch'} loading={workflow.busy} disabled={!workflow.uncertain && (disabled || workflow.needsPreview)} onClick={() => void save()}>{workflow.uncertain ? 'Recuperar mismo intento' : 'Guardar lote de revisión'}</Button>}</>}>
    <div ref={content} className="space-y-4">
      {discard && <Alert variant="warning">{workflow.uncertain ? 'El lote pudo guardarse. Cerrar pierde la solicitud en memoria y no revierte el servidor. Conserva la extracción y consulta los lotes antes de generar otro análisis.' : 'Se perderán la selección y la previsualización de este borrador.'}</Alert>}
      <div data-intake-error tabIndex={-1} className="space-y-3">{fileError && <Alert variant="danger">{fileError}</Alert>}{workflow.error && <Alert variant="danger">{workflow.error}</Alert>}</div>
      {!workflow.saved && <section className="space-y-4" aria-label="Extracción de origen"><Field label="JSON del extractor" disabled={disabled} error={fileError ?? undefined} hint="Un archivo .json, hasta 16 MiB. Se conserva el nombre y SHA-256 del Excel declarados en su contenido."><input ref={input} type="file" accept="application/json,.json" onChange={(event) => void chooseFile(event.target.files?.[0])} /></Field>{fileName && <div className="flex flex-wrap items-center gap-3"><span className="min-w-0 break-words">{fileName}</span><Button variant="ghost" size="sm" disabled={disabled} onClick={clearFile}>Quitar archivo</Button></div>}{readingFile && <LoadingState label="Validando la extracción JSON…" />}{workbook && <dl className="inventory-metadata-detail"><div><dt>Archivo de origen declarado</dt><dd>{workbook.source.fileName}</dd></div><div><dt>Alcance completo</dt><dd>{workbook.sheets.length} hojas · {workbook.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)} filas pobladas</dd></div><div><dt>SHA-256 declarado</dt><dd>{workbook.source.sha256}</dd></div></dl>}</section>}
      {workflow.reading && <LoadingState label="Comparando la extracción con el inventario…" />}
      {workflow.uncertain && <Alert variant="warning">No se pudo confirmar el guardado. Recupera exactamente el mismo origen y previewId; no cambies el archivo ni generes otra previsualización.</Alert>}
      {workflow.preview && !workflow.saved && <section className="space-y-4"><h3 data-intake-preview tabIndex={-1} className="font-semibold scroll-mt-6">Previsualización para revisión</h3><div className="import-review-summary"><Badge variant="neutral">Sin guardar</Badge><Badge variant="info">Comparado con inventario</Badge><Badge variant="danger">{workflow.preview.summary.blockingIssueCount} bloqueos</Badge><Badge variant="warning">{workflow.preview.summary.warningCount} advertencias</Badge></div><Alert variant={workflow.needsPreview ? 'warning' : 'info'}>{workflow.needsPreview ? 'La previsualización anterior no confirma vigencia. Genera otra antes de guardar.' : 'Guardar conserva el análisis, incluidos sus conflictos. Un lote guardado no está aprobado ni aplicado al inventario.'}</Alert><ImportPreviewTables key={workflow.preview.previewId} snapshot={workflow.preview} local /><Field label="Revisión del análisis" required disabled={disabled || workflow.needsPreview} error={invalid ? 'Confirma que revisaste el análisis antes de guardarlo.' : undefined}><Select value={confirmed ? 'reviewed' : ''} onChange={(value) => { setConfirmed(value === 'reviewed'); setInvalid(false); }} options={[{ value: '', label: 'Sin confirmar' }, { value: 'reviewed', label: 'Revisé el análisis. Guardar solo el lote de revisión.' }]} /></Field></section>}
      {workflow.saved && <section className="space-y-4"><h3 data-intake-saved tabIndex={-1} className="font-semibold">Origen guardado para revisión</h3><Alert variant="success">El servidor confirmó este lote. Sus incidencias siguen pendientes de revisión; no se crearon activos ni movimientos.</Alert><dl className="inventory-metadata-detail"><div><dt>Comprobante del lote</dt><dd>{workflow.saved.id}</dd></div><div><dt>Archivo</dt><dd>{workflow.saved.sourceFileName}</dd></div><div><dt>Primer registro administrativo</dt><dd>{formatInventoryDateTime(workflow.saved.createdAt)} · hora de Chile</dd></div><div><dt>Creado originalmente por (ID)</dt><dd>{workflow.saved.createdById}</dd></div></dl></section>}
    </div>
  </Dialog>;
}

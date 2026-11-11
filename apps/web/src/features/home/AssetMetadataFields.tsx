import { Field } from '../../ui';
import { assetMetadataFields, type AssetMetadataForm } from './inventory-metadata';

export function AssetMetadataFields({ form, errors, busy, onChange }: {
  form: AssetMetadataForm; errors: Partial<Record<keyof AssetMetadataForm, string>>; busy: boolean;
  onChange: (key: keyof AssetMetadataForm, value: string) => void;
}) {
  const field = (key: keyof AssetMetadataForm) => {
    const definition = assetMetadataFields.find((item) => item.key === key)!;
    return <Field key={key} label={definition.label} hint="Opcional" error={errors[key]} disabled={busy}>
      {key === 'notes'
        ? <textarea rows={3} className="resize-none" maxLength={definition.max} value={form[key]} placeholder={definition.placeholder} onChange={(event) => onChange(key, event.target.value)} />
        : <input maxLength={definition.max} value={form[key]} placeholder={definition.placeholder} onChange={(event) => onChange(key, event.target.value)} />}
    </Field>;
  };
  return <>
    <div className="grid gap-4 sm:grid-cols-2">{['technicalCondition', 'usagePurpose', 'location', 'sector'].map((key) => field(key as keyof AssetMetadataForm))}</div>
    <p className="ui-field-hint">Condición y finalidad describen el equipo. Su disponibilidad se controla mediante el estado y las entregas.</p>
    <details className="inventory-metadata-section" open={Boolean(form.ipAddress || form.hostname || errors.ipAddress || errors.hostname)}>
      <summary>Datos de red</summary><div className="grid gap-4 sm:grid-cols-2">{field('ipAddress')}{field('hostname')}</div>
    </details>
    <details className="inventory-metadata-section" open={Boolean(form.loanCode || errors.loanCode)}>
      <summary>Identificador de préstamo</summary>{field('loanCode')}
    </details>
    {field('notes')}
  </>;
}

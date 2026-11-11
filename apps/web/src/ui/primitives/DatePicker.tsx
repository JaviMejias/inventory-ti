import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { es } from 'date-fns/locale/es';
import 'react-day-picker/style.css';
import { DayPicker, type CalendarMonth } from 'react-day-picker';

import { inventoryDate } from '../../lib/date-range';
import { Select } from './Select';
import { Icon } from './Icon';

type DatePickerProps = {
  label: string;
  disabled?: boolean;
  inline?: boolean;
  allowFuture?: boolean;
  error?: string;
  value: string;
  minDate?: string;
  maxDate?: string;
  onChange: (value: string) => void;
  className?: string;
};

export function DatePicker({ label, value, minDate, maxDate, onChange, className, disabled = false, error, inline = false, allowFuture = false }: DatePickerProps) {
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<globalThis.HTMLDivElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const selectedDate = value ? parseIsoDate(value) : undefined;
  const initialDate = parseIsoDate(value || todayIso());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1, 12));
  const disabledDates = [minDate ? { before: parseIsoDate(minDate) } : undefined, maxDate ? { after: parseIsoDate(maxDate) } : undefined].filter((matcher): matcher is { before: Date } | { after: Date } => Boolean(matcher));
  useEffect(() => {
    const nextDate = parseIsoDate(value || todayIso());
    setCalendarMonth(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1, 12));
  }, [value]);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: globalThis.PointerEvent) => { if (!(event.target instanceof globalThis.Node)) return; const target = event.target; if (rootRef.current?.contains(target) || (target instanceof globalThis.Element && target.closest('.dashboard-picker-select'))) return; closePicker(); };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  // closePicker is intentionally kept local so the popover can animate before unmounting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => { if (closeTimerRef.current !== undefined) globalThis.clearTimeout(closeTimerRef.current); }, []);
  function openPicker() {
    if (closeTimerRef.current !== undefined) globalThis.clearTimeout(closeTimerRef.current);
    setClosing(false);
    setOpen(true);
  }
  function closePicker() {
    if (!open || closing) return;
    setClosing(true);
    closeTimerRef.current = globalThis.window.setTimeout(() => { setOpen(false); setClosing(false); closeTimerRef.current = undefined; }, 140);
  }
  function handleKeyDown(event: KeyboardEvent<globalThis.HTMLDivElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || !open) return;
    event.preventDefault();
    closePicker();
    rootRef.current?.querySelector<globalThis.HTMLButtonElement>('.dashboard-date-trigger')?.focus({ preventScroll: true });
  }
  return <div className={className ? `dashboard-date-field ${className}` : "dashboard-date-field"} ref={rootRef} onKeyDown={handleKeyDown}><label className="dashboard-date-label" htmlFor={`${errorId}-trigger`}>{label}</label><button id={`${errorId}-trigger`} className="dashboard-date-trigger" type="button" aria-label={`${label}: ${formatDateValue(value)}`} aria-expanded={open} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onClick={() => { if (open && !closing) closePicker(); else openPicker(); }}><span>{formatDateValue(value)}</span><CalendarIcon /></button>{open && <div className={inline ? "dashboard-date-popover dashboard-date-popover-inline" : "dashboard-date-popover"} data-state={closing ? 'closing' : 'open'}><DayPicker autoFocus mode="single" selected={selectedDate} onSelect={(date) => { if (date) { onChange(toIsoDate(date)); closePicker(); rootRef.current?.querySelector<globalThis.HTMLButtonElement>('.dashboard-date-trigger')?.focus({ preventScroll: true }); } }} disabled={disabledDates} showOutsideDays fixedWeeks weekStartsOn={1} navLayout="around" month={calendarMonth} onMonthChange={setCalendarMonth} startMonth={new Date(2020, 0, 1)} endMonth={maxDate ? parseIsoDate(maxDate) : allowFuture ? undefined : parseIsoDate(todayIso())} components={{ MonthCaption: ({ calendarMonth: month }) => <MonthCaption calendarMonth={month} allowFuture={allowFuture} onChange={setCalendarMonth} /> }} locale={es} /></div>}{error && <span id={errorId} className="ui-field-error" role="alert">{error}</span>}</div>;
}
function MonthCaption({ calendarMonth, onChange, allowFuture = false }: { calendarMonth: CalendarMonth; allowFuture?: boolean; onChange: (month: Date) => void }) {
  const current = calendarMonth.date;
  const year = current.getFullYear();
  const month = current.getMonth();
  const lastYear = Math.max(year, new Date().getFullYear() + (allowFuture ? 10 : 0));
  const yearOptions = Array.from({ length: lastYear - 2019 }, (_, index) => { const optionYear = 2020 + index; return { value: String(optionYear), label: String(optionYear) }; });
  const monthOptions = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: new Intl.DateTimeFormat('es-CL', { month: 'long' }).format(new Date(2020, index, 1)) }));
  return <div className="rdp-month_caption dashboard-calendar-caption"><Select aria-label="Mes" className="dashboard-picker-select" value={String(month)} onChange={(value) => onChange(new Date(year, Number(value), 1, 12))} options={monthOptions} /><Select aria-label="Año" className="dashboard-picker-select" value={String(year)} onChange={(value) => onChange(new Date(Number(value), month, 1, 12))} options={yearOptions} /></div>;
}

function parseIsoDate(value: string) { const [year, month, day] = value.split('-').map(Number); if (![year, month, day].every(Number.isFinite) || month < 1 || month > 12 || day < 1 || day > 31) return parseIsoDate(todayIso()); return new Date(year, month - 1, day, 12); }
function toIsoDate(value: Date) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function formatDateValue(value: string) { if (!value) return 'Seleccionar fecha'; return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }).format(parseIsoDate(value)).replaceAll('.', ''); }

function todayIso() { return inventoryDate(); }
function CalendarIcon() { return <Icon><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Icon>; }

import { useEffect, useRef, useState } from 'react';
import { es } from 'date-fns/locale/es';
import 'react-day-picker/style.css';
import { DayPicker, type CalendarMonth } from 'react-day-picker';

import { Select } from './Select';
import { Icon } from './Icon';

type DatePickerProps = {
  label: string;
  value: string;
  minDate?: string;
  maxDate?: string;
  onChange: (value: string) => void;
  className?: string;
};

export function DatePicker({ label, value, minDate, maxDate, onChange, className }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [month, setMonth] = useState(() => monthFrom(value || todayIso()));
  const rootRef = useRef<globalThis.HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => { setMonth(monthFrom(value || todayIso())); }, [value]);
  useEffect(() => () => { if (timerRef.current !== undefined) globalThis.clearTimeout(timerRef.current); }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof globalThis.Node && !rootRef.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  // close is intentionally stable for the short-lived listener.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    if (!open || closing) return;
    setClosing(true);
    timerRef.current = globalThis.window.setTimeout(() => { setOpen(false); setClosing(false); }, 140);
  }
  const disabled = [minDate ? { before: parseDate(minDate) } : undefined, maxDate ? { after: parseDate(maxDate) } : undefined].filter(Boolean) as Array<{ before: Date } | { after: Date }>;
  return <div ref={rootRef} className={className ? `dashboard-date-field ${className}` : 'dashboard-date-field'}><span className="dashboard-date-label">{label}</span><button type="button" className="dashboard-date-trigger" aria-label={label + ': ' + (value ? formatDate(value) : 'Seleccionar fecha')} aria-expanded={open} onClick={() => { if (open) close(); else { setClosing(false); setOpen(true); } }}><span>{value ? formatDate(value) : 'Seleccionar fecha'}</span><CalendarIcon /></button>{open && <div className="dashboard-date-popover" data-state={closing ? 'closing' : 'open'}><DayPicker mode="single" selected={value ? parseDate(value) : undefined} month={month} onMonthChange={setMonth} onSelect={(next) => { if (next) { onChange(toIso(next)); close(); } }} disabled={disabled} showOutsideDays fixedWeeks weekStartsOn={1} navLayout="around" startMonth={new Date(2020, 0, 1)} endMonth={new Date()} locale={es} components={{ MonthCaption: ({ calendarMonth }) => <MonthCaption calendarMonth={calendarMonth} onChange={setMonth} /> }} /></div>}</div>;
}

function MonthCaption({ calendarMonth, onChange }: { calendarMonth: CalendarMonth; onChange: (month: Date) => void }) {
  const year = calendarMonth.date.getFullYear(); const currentMonth = calendarMonth.date.getMonth();
  const years = Array.from({ length: new Date().getFullYear() - 2019 }, (_, index) => ({ value: String(2020 + index), label: String(2020 + index) }));
  const months = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: new Intl.DateTimeFormat('es-CL', { month: 'long' }).format(new Date(2020, index, 1)) }));
  return <div className="rdp-month_caption dashboard-calendar-caption"><Select className="dashboard-picker-select dashboard-calendar-month-select" value={String(currentMonth)} onChange={(next) => onChange(new Date(year, Number(next), 1, 12))} options={months} /><Select className="dashboard-picker-select dashboard-calendar-year-select" value={String(year)} onChange={(next) => onChange(new Date(Number(next), currentMonth, 1, 12))} options={years} /></div>;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }
function parseDate(value: string) { const [year, month, day] = value.split('-').map(Number); if (![year, month, day].every(Number.isFinite) || month < 1 || month > 12 || day < 1 || day > 31) return parseDate(todayIso()); return new Date(year, month - 1, day, 12); }
function monthFrom(value: string) { const date = parseDate(value); return new Date(date.getFullYear(), date.getMonth(), 1, 12); }
function toIso(value: Date) { return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0'); }
function formatDate(value: string) { return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }).format(parseDate(value)).replaceAll('.', ''); }
function CalendarIcon() { return <Icon size="sm"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Icon>; }

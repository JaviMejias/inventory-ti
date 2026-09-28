import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../utils';
import { Icon } from './Icon';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  resultLimit?: number;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
};

const DEFAULT_RESULT_LIMIT = 8;
const MENU_GAP = 8;

type PopoverPosition = Pick<CSSProperties, 'top' | 'bottom' | 'left' | 'width'>;

export function Select({ value, options, onChange, placeholder = 'Selecciona una opción', searchable = false, resultLimit = DEFAULT_RESULT_LIMIT, searchPlaceholder = 'Buscar…', emptyMessage = 'No hay coincidencias.', disabled = false, required = false, id, className, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, 'aria-invalid': invalid }: SelectProps) {
  const generatedId = useId();
  const triggerId = id ?? `select-${generatedId}`;
  const listboxId = `${triggerId}-listbox`;
  const rootRef = useRef<globalThis.HTMLDivElement>(null);
  const triggerRef = useRef<globalThis.HTMLButtonElement>(null);
  const searchRef = useRef<globalThis.HTMLInputElement>(null);
  const popoverRef = useRef<globalThis.HTMLDivElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [opensUpward, setOpensUpward] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({});

  const selected = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('es-CL');
    return normalizedQuery ? options.filter((option) => option.label.toLocaleLowerCase('es-CL').includes(normalizedQuery)) : options;
  }, [options, query]);
  const visibleOptions = useMemo(() => {
    if (!searchable || filteredOptions.length <= resultLimit) return filteredOptions;
    const limitedOptions = filteredOptions.slice(0, resultLimit);
    if (query.trim() || !selected || limitedOptions.some((option) => option.value === selected.value)) return limitedOptions;
    return [selected, ...limitedOptions.filter((option) => option.value !== selected.value)].slice(0, resultLimit);
  }, [filteredOptions, query, resultLimit, searchable, selected]);

  useEffect(() => () => { if (closeTimerRef.current !== undefined) globalThis.clearTimeout(closeTimerRef.current); }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof globalThis.Node && !rootRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) closeMenu();
    };
    globalThis.document.addEventListener('pointerdown', handlePointerDown);
    return () => globalThis.document.removeEventListener('pointerdown', handlePointerDown);
  // closeMenu is intentionally kept local so the popover can animate before unmounting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dialog = triggerRef.current?.closest('dialog');
    const position = () => {
      const bounds = triggerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const viewportHeight = globalThis.visualViewport?.height ?? globalThis.innerHeight;
      const viewportWidth = globalThis.visualViewport?.width ?? globalThis.innerWidth;
      const spaceBelow = viewportHeight - bounds.bottom;
      const spaceAbove = bounds.top;
      const shouldOpenUpward = spaceBelow < 260 && spaceAbove > spaceBelow;
      const width = Math.min(bounds.width, viewportWidth - 16);
      const viewportLeft = Math.min(Math.max(8, bounds.left), viewportWidth - width - 8);
      setOpensUpward(shouldOpenUpward);
      if (dialog) {
        const dialogBounds = dialog.getBoundingClientRect();
        const localLeft = Math.max(12, Math.min(bounds.left - dialogBounds.left, dialogBounds.width - width - 12));
        setPopoverPosition(shouldOpenUpward
          ? { bottom: dialogBounds.bottom - bounds.top + MENU_GAP, left: localLeft, width }
          : { top: bounds.bottom - dialogBounds.top + MENU_GAP, left: localLeft, width });
        return;
      }
      setPopoverPosition(shouldOpenUpward
        ? { bottom: viewportHeight - bounds.top + MENU_GAP, left: viewportLeft, width }
        : { top: bounds.bottom + MENU_GAP, left: viewportLeft, width });
    };
    const handleDialogAnimationEnd = (event: globalThis.AnimationEvent) => {
      if (event.target === dialog) position();
    };
    position();
    // Dialog entrance scaling can change measured bounds without a resize event.
    dialog?.addEventListener('animationend', handleDialogAnimationEnd);
    globalThis.addEventListener('resize', position);
    globalThis.addEventListener('scroll', position, true);
    return () => {
      dialog?.removeEventListener('animationend', handleDialogAnimationEnd);
      globalThis.removeEventListener('resize', position);
      globalThis.removeEventListener('scroll', position, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = visibleOptions.findIndex((option) => option.value === value && !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : Math.max(0, visibleOptions.findIndex((option) => !option.disabled)));
    const frame = globalThis.requestAnimationFrame(() => {
      if (searchable) searchRef.current?.focus();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [open, searchable, value, visibleOptions]);

  function openMenu() {
    if (disabled) return;
    if (closeTimerRef.current !== undefined) globalThis.clearTimeout(closeTimerRef.current);
    setClosing(false);
    setQuery('');
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    if (!open || closing) return;
    setClosing(true);
    setQuery('');
    closeTimerRef.current = globalThis.window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimerRef.current = undefined;
      if (restoreFocus) triggerRef.current?.focus();
    }, 140);
  }

  function selectOption(option: SelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  }

  function moveActive(step: number) {
    if (visibleOptions.length === 0) return;
    let next = activeIndex;
    for (let attempts = 0; attempts < visibleOptions.length; attempts += 1) {
      next = (next + step + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<globalThis.HTMLButtonElement | globalThis.HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); closeMenu(true); }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (!open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (open && event.key === 'Enter' && !(event.nativeEvent as globalThis.KeyboardEvent).isComposing) {
      event.preventDefault();
      const activeOption = visibleOptions[activeIndex];
      if (activeOption) selectOption(activeOption);
    }
  }

  const portalTarget = triggerRef.current?.closest('dialog') ?? globalThis.document.body;
  const insideDialog = portalTarget instanceof globalThis.HTMLDialogElement;

  return (
    <div ref={rootRef} className={cx('ui-select', open && 'ui-select-open', opensUpward && 'ui-select-upward', className)}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="ui-select-trigger"
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && !searchable && visibleOptions[activeIndex] ? listboxId + '-' + visibleOptions[activeIndex].value : undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-required={required || undefined}
        onClick={() => { if (open && !closing) closeMenu(); else openMenu(); }}
        onKeyDown={handleKeyDown}
      >
        <span className={cx('ui-select-value', !selected && 'ui-select-placeholder')}>{selected?.label ?? placeholder}</span>
        <ChevronIcon />
      </button>

      {open && createPortal(<div ref={popoverRef} className={cx('ui-select-popover', insideDialog && 'ui-select-popover-in-dialog', className, opensUpward && 'ui-select-popover-upward')} data-state={closing ? 'closing' : 'open'} style={popoverPosition}>
        {searchable && <div className="ui-select-search"><SearchIcon /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder={searchPlaceholder} type="search" role="searchbox" aria-label={searchPlaceholder} aria-controls={listboxId} aria-activedescendant={visibleOptions[activeIndex] ? `${listboxId}-${visibleOptions[activeIndex].value}` : undefined} /></div>}
        <div id={listboxId} className="ui-select-options" role="listbox" aria-labelledby={triggerId} style={{ '--ui-select-visible-options': Math.min(resultLimit, Math.max(visibleOptions.length, 1)) } as CSSProperties}>
          {filteredOptions.length === 0 && <p className="ui-select-empty" role="status">{emptyMessage}</p>}
          {visibleOptions.map((option, index) => <button id={`${listboxId}-${option.value}`} className={cx('ui-select-option', option.value === value && 'ui-select-option-selected', index === activeIndex && 'ui-select-option-active')} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} key={option.value} onMouseEnter={() => setActiveIndex(index)} onClick={() => selectOption(option)}><span>{option.label}</span>{option.value === value && <CheckIcon />}</button>)}
        </div>
      </div>, portalTarget)}
    </div>
  );
}

function ChevronIcon() { return <Icon className="ui-select-chevron" size="sm"><path d="m6 9 6 6 6-6" /></Icon>; }
function SearchIcon() { return <Icon className="ui-select-search-icon" size="sm"><circle cx="10.8" cy="10.8" r="6.2" /><path d="m16 16 4 4" /></Icon>; }
function CheckIcon() { return <Icon className="ui-select-check" size="sm"><path d="m5 12 4 4L19 6" /></Icon>; }

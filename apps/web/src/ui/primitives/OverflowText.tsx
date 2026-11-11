import { createElement, useLayoutEffect, useRef, useState } from 'react';

type OverflowTextProps = {
  as?: 'span' | 'strong' | 'small';
  text: string;
  className?: string;
};

/** Keeps the full value available when CSS truncates the visible table text. */
export function OverflowText({ as = 'span', text, className }: OverflowTextProps) {
  const elementRef = useRef<globalThis.HTMLElement | null>(null);
  const [isClipped, setIsClipped] = useState(false);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;

    const measure = () => {
      setIsClipped(element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
    };

    measure();
    if (typeof globalThis.ResizeObserver === 'undefined') return undefined;
    const observer = new globalThis.ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return createElement(as, {
    className: className ? `ui-overflow-text ${className}` : 'ui-overflow-text',
    ref: (element: globalThis.HTMLElement | null) => { elementRef.current = element; },
    title: isClipped ? text : undefined,
    tabIndex: isClipped ? 0 : undefined
  } as never, text);
}

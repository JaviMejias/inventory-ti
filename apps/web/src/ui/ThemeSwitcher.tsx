import { useState, type ReactNode } from 'react';

import { getThemePreference, setThemePreference, type ThemePreference } from '../theme/theme';

const options: Array<{ value: ThemePreference; label: string; icon: ReactNode }> = [
  { value: 'system', label: 'Seguir tema del sistema', icon: <SystemIcon /> },
  { value: 'light', label: 'Tema claro', icon: <SunIcon /> },
  { value: 'dark', label: 'Tema oscuro', icon: <MoonIcon /> }
];

export function ThemeSwitcher({ className = '' }: { className?: string }) {
  const [value, setValue] = useState<ThemePreference>(() => getThemePreference());
  function chooseTheme(theme: ThemePreference) {
    setValue(theme);
    setThemePreference(theme);
  }

  return <div className={`app-theme-switcher ${className}`.trim()} role="group" aria-label="Tema de color">
    {options.map((option) => <button className={`app-theme-option${value === option.value ? ' app-theme-option-active' : ''}`} type="button" key={option.value} aria-label={option.label} aria-pressed={value === option.value} title={option.label} onClick={() => chooseTheme(option.value)}>{option.icon}</button>)}
  </div>;
}

function AppIcon({ children }: { children: ReactNode }) { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>; }
function SunIcon() { return <AppIcon><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></AppIcon>; }
function MoonIcon() { return <AppIcon><path d="M20 15.2A8 8 0 0 1 8.8 4 8.1 8.1 0 1 0 20 15.2Z" /></AppIcon>; }
function SystemIcon() { return <AppIcon><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></AppIcon>; }

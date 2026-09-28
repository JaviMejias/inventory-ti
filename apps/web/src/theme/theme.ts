export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'inventory-ti-theme';
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function getThemePreference(): ThemePreference {
  try {
    const storedTheme = globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemePreference(storedTheme) ? storedTheme : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;

  const systemIsDark = globalThis.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false;
  const isDark = preference === 'dark' || (preference === 'system' && systemIsDark);
  root.classList.toggle('dark', isDark);
  root.dataset.theme = preference;
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The visual preference still applies when storage is unavailable.
  }
  applyTheme(preference);
}

export function initializeTheme(): void {
  applyTheme(getThemePreference());

  const systemTheme = globalThis.matchMedia?.(SYSTEM_DARK_QUERY);
  systemTheme?.addEventListener('change', () => {
    if (globalThis.document.documentElement.dataset.theme === 'system') {
      applyTheme('system');
    }
  });
}

export const translations = {
  es: {
    title: 'Inventory TI',
    eyebrow: 'Centro de operaciones',
    ready: 'El inventario',
    heroAccent: 'bajo control.',
    description: 'Un punto de partida claro para saber qué existe, dónde está y qué necesita atención.',
    moduleEyebrow: 'Acceso rápido',
    moduleTitle: '¿Qué necesitas hacer?'
  },
  en: {
    title: 'Inventory TI',
    eyebrow: 'Operations center',
    ready: 'Inventory',
    heroAccent: 'under control.',
    description: 'A clear starting point to know what exists, where it is, and what needs attention.',
    moduleEyebrow: 'Quick access',
    moduleTitle: 'What do you need to do?'
  }
} as const;

export type Locale = keyof typeof translations;

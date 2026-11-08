/**
 * Интеграция с Telegram Mini App.
 *
 * Приложение должно работать и вне Telegram — в обычном браузере во время
 * разработки. Поэтому все обращения к SDK защищены проверкой: нет Telegram —
 * работаем как обычная веб-страница со светлой темой.
 */

type TelegramWebApp = {
  ready: () => void;
  expand: () => void;
  colorScheme: 'light' | 'dark';
  initData: string;
  themeParams: Record<string, string>;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
  onEvent: (event: string, handler: () => void) => void;
  setHeaderColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function initTelegram(): void {
  const app = getWebApp();

  if (!app) {
    /** Разработка в браузере: тему берём из системных настроек. */
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', prefersDark);
    return;
  }

  app.ready();
  app.expand();

  /**
   * Вертикальные свайпы закрывают Mini App — на экране со списком задач
   * это означает случайное закрытие при каждой прокрутке вверх.
   */
  app.disableVerticalSwipes?.();

  applyTheme(app);
  app.onEvent('themeChanged', () => applyTheme(app));
}

function applyTheme(app: TelegramWebApp): void {
  document.documentElement.classList.toggle('dark', app.colorScheme === 'dark');

  /** Шапка Telegram красится в фон приложения, чтобы стык не бросался в глаза. */
  const background = app.colorScheme === 'dark' ? '#0e1116' : '#fafaf7';
  app.setHeaderColor?.(background);
}

/** Тактильный отклик на подтверждение задачи: короткий, только на значимых действиях. */
export function haptic(kind: 'tap' | 'success' | 'error' = 'tap'): void {
  const hf = getWebApp()?.HapticFeedback;
  if (!hf) return;
  if (kind === 'tap') hf.impactOccurred('light');
  else hf.notificationOccurred(kind);
}

/** Сырая initData для входа. Проверяется на сервере — здесь ей не доверяем. */
export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

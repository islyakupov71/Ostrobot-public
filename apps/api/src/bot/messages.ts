import {
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  type TaskPriority,
  type TaskStatus,
} from '@ostro/shared';

/**
 * Тексты бота.
 *
 * Собраны в одном месте по той же причине, что и подписи статусов: человек
 * читает эти строки по двадцать раз в день, и любая небрежность в них
 * читается как небрежность всей системы. Правило простое — говорим о том,
 * что человеку делать, а не о том, что произошло внутри базы.
 */

const escape = (value: string): string =>
  value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);

/** Экран подтверждения личности — первое, что видит новый сотрудник. */
export function identityConfirmation(user: {
  firstName: string;
  lastName: string | null;
  position: string | null;
}): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');

  return [
    `👋 Привет, ${escape(user.firstName)}!`,
    '',
    'Вы подключены к рабочему боту команды.',
    '',
    'Ваш профиль:',
    `<b>${escape(fullName)}</b>`,
    user.position ? escape(user.position) : '<i>должность не указана</i>',
    '',
    'Всё верно?',
  ].join('\n');
}

/** Сотрудника нет в системе: не пугаем ошибкой, объясняем следующий шаг. */
export const notRegistered = [
  '🔒 Тебя пока нет в списке команды.',
  '',
  'Попроси администратора добавить тебя — ему понадобится твой Telegram ID:',
].join('\n');

export const identityRejected = [
  'Понял, профиль не твой.',
  '',
  'Я сообщил администратору — он поправит данные и вернётся к тебе.',
  'Пока доступ закрыт.',
].join('\n');

export function welcomeAfterConfirm(firstName: string, isManager: boolean): string {
  return [
    `Готово, ${escape(firstName)}. Доступ открыт.`,
    '',
    'Я буду присылать сюда новые задачи, напоминать о дедлайнах',
    'и подсказывать, когда пора сдать отчёт.',
    '',
    isManager
      ? 'Как руководителю тебе доступны сводки по команде и проектам.'
      : 'Всё остальное — в меню ниже.',
  ].join('\n');
}

const PRIORITY_MARK: Record<TaskPriority, string> = {
  low: '',
  normal: '',
  high: '🔸',
  critical: '⚡',
};

/** Карточка задачи в чате. */
export function taskCard(task: {
  ref: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  deadlineAt: Date | null;
  projectName: string;
  authorName: string | null;
  timezone: string;
}): string {
  const lines = [
    `${PRIORITY_MARK[task.priority]} <b>${escape(task.title)}</b>`,
    `<code>${task.ref}</code> · ${escape(task.projectName)}`,
  ];

  if (task.description) {
    lines.push('', escape(task.description));
  }

  lines.push('', `Статус: ${TASK_STATUS_LABEL[task.status]}`);

  if (task.priority === 'high' || task.priority === 'critical') {
    lines.push(`Приоритет: ${TASK_PRIORITY_LABEL[task.priority]}`);
  }

  if (task.deadlineAt) {
    lines.push(`Срок: ${formatDeadline(task.deadlineAt, task.timezone)}`);
  }

  if (task.authorName) {
    lines.push(`Поставил: ${escape(task.authorName)}`);
  }

  return lines.join('\n');
}

/** Новая задача: заголовок отдельно, чтобы уведомление читалось с первой строки. */
export function newTaskNotification(taskBody: string): string {
  return ['📋 <b>Новая задача</b>', '', taskBody, '', 'Подтверди, что увидел.'].join('\n');
}

export function deadlineReminder(taskBody: string, hoursLeft: number): string {
  const header =
    hoursLeft <= 3
      ? '⚡ <b>Дедлайн сегодня</b>'
      : hoursLeft <= 24
        ? '⏰ <b>Дедлайн завтра</b>'
        : '📅 <b>Приближается срок</b>';

  return [header, '', taskBody].join('\n');
}

export function overdueNotification(taskBody: string, overdueFor: string): string {
  return ['🔴 <b>Просрочено</b>', `Срок прошёл ${overdueFor} назад.`, '', taskBody].join('\n');
}

export function noReactionEscalation(taskBody: string, assigneeName: string): string {
  return [
    '👀 <b>Нет реакции на задачу</b>',
    `${escape(assigneeName)} пока не подтвердил получение.`,
    '',
    taskBody,
  ].join('\n');
}

export const helpText = [
  '<b>Что я умею</b>',
  '',
  '📋 <b>Мои задачи</b> — всё, что на тебе, свежее сверху',
  '🔥 <b>Сегодня</b> — то, что горит прямо сейчас',
  '📅 <b>Дедлайны</b> — ближайшие сроки на неделю вперёд',
  '📊 <b>Отчётность</b> — что и когда сдавать',
  '🔔 <b>Уведомления</b> — настроить, о чём и когда писать',
  '',
  'Когда прилетает новая задача, жми <b>Взял</b> — так руководитель видит,',
  'что она в работе, и перестаёт дёргать.',
  '',
  'Если застрял — жми <b>Застрял</b> и напиши, что мешает.',
  'Это не жалоба, это самый быстрый способ разблокироваться.',
].join('\n');

/* --------------------------------------------------------- Форматирование */

export function formatDeadline(date: Date, timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });

  const diffHours = (date.getTime() - now.getTime()) / 3_600_000;

  if (diffHours < 0) return `${formatter.format(date)} — просрочено`;
  if (diffHours < 24) return `сегодня в ${formatTime(date, timezone)}`;
  if (diffHours < 48) return `завтра в ${formatTime(date, timezone)}`;

  return formatter.format(date);
}

export function formatTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Человеческая длительность: «2 часа», «3 дня». Для текстов о просрочке. */
export function humanDuration(millis: number): string {
  const minutes = Math.floor(millis / 60_000);
  if (minutes < 60) return plural(minutes, 'минуту', 'минуты', 'минут');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'час', 'часа', 'часов');

  const days = Math.floor(hours / 24);
  return plural(days, 'день', 'дня', 'дней');
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

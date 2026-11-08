import { InlineKeyboard } from 'grammy';
import type { NotificationKind, TaskStatus } from '@ostro/shared';
import { TASK_STATUS_LABEL } from '@ostro/shared';

/**
 * Тексты автоматических сообщений.
 *
 * У каждого повода — своя интонация. Напоминание за сутки должно звучать
 * как подсказка, сообщение о просрочке — как факт, эскалация руководителю —
 * как сводка, а не как жалоба на человека.
 */

type ReminderTaskData = {
  task: { id: string; title: string; status: TaskStatus; deadlineAt: Date | null } | null;
  projectName: string | null;
  ref: string | null;
  timezone: string;
};

const escape = (v: string) => v.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function taskLine(data: ReminderTaskData): string {
  if (!data.task) return '';
  const parts = [`<b>${escape(data.task.title)}</b>`];
  if (data.ref) {
    parts.push(`<code>${data.ref}</code>${data.projectName ? ` · ${escape(data.projectName)}` : ''}`);
  }
  return parts.join('\n');
}

function deadlineLine(data: ReminderTaskData): string {
  if (!data.task?.deadlineAt) return '';
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    timeZone: data.timezone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(data.task.deadlineAt);
  return `Срок: ${formatted}`;
}

/** Возвращает null, если по этому поводу писать уже нечего — напоминание отменится. */
export function buildReminderText(kind: NotificationKind, data: ReminderTaskData): string | null {
  const body = taskLine(data);
  const deadline = deadlineLine(data);

  switch (kind) {
    case 'task_assigned':
      return ['📋 <b>Новая задача</b>', '', body, deadline, '', 'Подтверди, что увидел.']
        .filter(Boolean)
        .join('\n');

    case 'task_no_reaction':
      return [
        '👀 <b>Задача ждёт ответа</b>',
        '',
        body,
        deadline,
        '',
        'Нажми «Взял» — руководитель перестанет уточнять.',
      ]
        .filter(Boolean)
        .join('\n');

    case 'deadline_approaching':
      return ['📅 <b>Срок завтра</b>', '', body, deadline].filter(Boolean).join('\n');

    case 'deadline_today':
      return ['⚡ <b>Срок сегодня</b>', '', body, deadline].filter(Boolean).join('\n');

    case 'task_overdue':
      return [
        '🔴 <b>Срок прошёл</b>',
        '',
        body,
        deadline,
        '',
        'Если не успеваешь — отметь «Застрял» и напиши, что мешает.',
      ]
        .filter(Boolean)
        .join('\n');

    case 'task_status_stale':
      return [
        '🕰 <b>По задаче давно нет движения</b>',
        '',
        body,
        `Статус не менялся: ${data.task ? TASK_STATUS_LABEL[data.task.status] : ''}`,
        '',
        'Обнови статус — это тридцать секунд.',
      ]
        .filter(Boolean)
        .join('\n');

    case 'kp_awaiting_receipt':
      return [
        '📨 <b>КП отправлено, получение не подтверждено</b>',
        '',
        body,
        '',
        'Клиент подтвердил, что получил?',
      ]
        .filter(Boolean)
        .join('\n');

    case 'kp_overdue':
      return ['🔴 <b>КП просрочено</b>', '', body, deadline].filter(Boolean).join('\n');

    case 'report_due':
      return ['📊 <b>Скоро сдавать отчёт</b>', '', body || 'Регулярная отчётность', deadline]
        .filter(Boolean)
        .join('\n');

    case 'report_missing':
      return ['📊 <b>Отчёт не сдан</b>', '', body || 'Регулярная отчётность', deadline]
        .filter(Boolean)
        .join('\n');

    case 'status_table_unfilled':
      return [
        '📋 <b>Статус-таблица не заполнена</b>',
        '',
        'Без неё сводка по проекту неполная — руководитель не видит картину.',
      ].join('\n');

    case 'escalation':
      return ['⚠️ <b>Нужна реакция</b>', '', body, deadline].filter(Boolean).join('\n');

    case 'manager_digest':
      /** Сводка собирается отдельным заданием со своими данными. */
      return null;

    default:
      return null;
  }
}

/** Кнопки под напоминанием: одно нажатие вместо перехода в приложение. */
export function reminderKeyboard(
  taskId: string,
  status: TaskStatus,
  webAppUrl: string,
): InlineKeyboard | undefined {
  const keyboard = new InlineKeyboard();

  if (status === 'new') {
    keyboard.text('✅ Взял', `task:ack:${taskId}`).row();
  } else if (status === 'acknowledged' || status === 'in_progress') {
    keyboard.text('📤 Сдал', `task:submit:${taskId}`);
    keyboard.text('🚧 Застрял', `task:block:${taskId}`).row();
  }

  if (webAppUrl) {
    keyboard.webApp('Открыть карточку', `${webAppUrl}/task/${taskId}`);
  }

  return keyboard;
}

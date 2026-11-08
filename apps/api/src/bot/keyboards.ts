import { InlineKeyboard, Keyboard } from 'grammy';
import type { TaskStatus, UserRole } from '@ostro/shared';

/**
 * Клавиатуры бота.
 *
 * Постоянное меню повторяет структуру из ТЗ. Инлайн-кнопки под карточкой
 * задачи показывают только те действия, которые сейчас реально доступны:
 * кнопка, которая отвечает «нельзя», хуже, чем отсутствие кнопки.
 */

export const MENU = {
  myTasks: '📋 Мои задачи',
  today: '🔥 Сегодня',
  deadlines: '📅 Дедлайны',
  reports: '📊 Отчётность',
  notifications: '🔔 Уведомления',
  help: 'ℹ️ Помощь',
  team: '👥 Команда',
  projects: '📈 Статус проектов',
} as const;

/** Главное меню. Руководителю добавляются две строки сверх базовых. */
export function mainMenu(role: UserRole): Keyboard {
  const keyboard = new Keyboard()
    .text(MENU.myTasks)
    .text(MENU.today)
    .row()
    .text(MENU.deadlines)
    .text(MENU.reports)
    .row();

  if (role === 'manager' || role === 'admin') {
    keyboard.text(MENU.team).text(MENU.projects).row();
  }

  return keyboard.text(MENU.notifications).text(MENU.help).resized().persistent();
}

/** Экран подтверждения личности при первом запуске. */
export function identityConfirm(): InlineKeyboard {
  return new InlineKeyboard().text('✅ Да', 'identity:yes').text('❌ Это не я', 'identity:no');
}

/**
 * Действия под карточкой задачи.
 *
 * Набор зависит от текущего статуса: пока задача не принята, единственное
 * осмысленное действие — принять её. Приёмку («Готово») исполнителю
 * не показываем вовсе — это право постановщика.
 */
export function taskActions(
  taskId: string,
  status: TaskStatus,
  opts: { isAssignee: boolean; canAccept: boolean; webAppUrl?: string },
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (opts.isAssignee) {
    switch (status) {
      case 'new':
        keyboard.text('✅ Взял', `task:ack:${taskId}`).row();
        break;
      case 'acknowledged':
        keyboard.text('▶️ В работе', `task:start:${taskId}`);
        keyboard.text('🚧 Застрял', `task:block:${taskId}`).row();
        break;
      case 'in_progress':
        keyboard.text('📤 Сдал', `task:submit:${taskId}`);
        keyboard.text('🚧 Застрял', `task:block:${taskId}`).row();
        break;
      case 'blocked':
        keyboard.text('▶️ Разблокировался', `task:start:${taskId}`).row();
        break;
      default:
        break;
    }
  }

  if (opts.canAccept && status === 'submitted') {
    keyboard.text('✔️ Принять работу', `task:accept:${taskId}`);
    keyboard.text('↩️ Вернуть', `task:reopen:${taskId}`).row();
  }

  if (opts.webAppUrl) {
    keyboard.webApp('Открыть карточку', `${opts.webAppUrl}/task/${taskId}`);
  }

  return keyboard;
}

/** Кнопка «перенести срок» для руководителя — открывает Mini App на нужном экране. */
export function deadlineActions(taskId: string, webAppUrl: string): InlineKeyboard {
  return new InlineKeyboard().webApp('📅 Перенести срок', `${webAppUrl}/task/${taskId}/deadline`);
}

/** Кнопка запуска Mini App из любого места разговора. */
export function openApp(webAppUrl: string, label = '🚀 Открыть ОСТРО'): InlineKeyboard {
  return new InlineKeyboard().webApp(label, webAppUrl);
}

/** Подтверждение получения КП. */
export function kpActions(kpId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📨 Клиент получил', `kp:received:${kpId}`)
    .row()
    .text('✅ Согласовано', `kp:approved:${kpId}`)
    .text('❌ Отклонено', `kp:rejected:${kpId}`);
}

import { Bot, GrammyError, HttpError, type Context } from 'grammy';
import { and, count, eq, isNull, or, type Database } from '@ostro/db';
import { users, tasks, taskEvents } from '@ostro/db';
import { checkTransition, statusSideEffects } from '@ostro/core';
import type { TaskStatus } from '@ostro/shared';
import * as msg from './messages.js';
import { MENU, identityConfirm, mainMenu, taskActions } from './keyboards.js';
import { fetchAvatar } from '../lib/avatars.js';
import * as views from './views.js';

/**
 * Telegram-бот ОСТРО.
 *
 * Бот — не второй интерфейс поверх Mini App, а быстрый путь для одного
 * конкретного действия: увидеть задачу и одним нажатием сообщить, что она
 * взята. Всё, что требует ввода и разглядывания, живёт в Mini App;
 * бот доводит человека до кнопки за один экран.
 */

export type BotContext = Context & {
  /** Профиль из нашей базы; отсутствует, пока человек не опознан. */
  dbUser?: typeof users.$inferSelect;
};

export type BotDeps = {
  db: Database;
  webAppUrl: string;
};

export function createBot(token: string, deps: BotDeps): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);
  const { db, webAppUrl } = deps;

  /**
   * Подтягивание аватарки.
   *
   * Запускается фоном и не блокирует ответ боту: экран постановки задачи
   * переживёт отсутствие фотографии — покажет инициалы, — а вот заминка
   * на приветствии заметна сразу.
   */
  const pullAvatar = (telegramId: string | number, userId: string) => {
    void fetchAvatar(bot.api, telegramId, userId, token).catch(() => false);
  };

  /**
   * Опознание на каждом апдейте.
   *
   * По ТЗ Telegram ID — уникальный идентификатор пользователя. Но админ,
   * заводя сотрудника, обычно знает только @username, поэтому при первом
   * контакте мы дописываем ID в заранее созданную карточку.
   */
  bot.use(async (ctx, next) => {
    const tgId = ctx.from?.id;
    if (!tgId) return next();

    const tgIdText = String(tgId);
    const username = ctx.from?.username?.toLowerCase() ?? null;

    const [found] = await db
      .select()
      .from(users)
      .where(
        or(
          eq(users.telegramId, tgIdText),
          username
            ? and(eq(users.telegramUsername, username), isNull(users.telegramId))
            : undefined,
        ),
      )
      .limit(1);

    if (found) {
      /** Карточка была заведена по username — привязываем ID навсегда. */
      if (!found.telegramId) {
        await db
          .update(users)
          .set({ telegramId: tgIdText, updatedAt: new Date() })
          .where(eq(users.id, found.id));
        found.telegramId = tgIdText;
      }

      ctx.dbUser = found;

      await db
        .update(users)
        .set({ lastSeenAt: new Date() })
        .where(eq(users.id, found.id));
    }

    return next();
  });

  /* ------------------------------------------------------------- /start */

  bot.command('start', async (ctx) => {
    let user = ctx.dbUser;

    /**
     * Первый запуск системы.
     *
     * Пока в базе нет ни одного человека, тот, кто первым нажал /start,
     * становится администратором. Без этого не с чего начать: завести
     * сотрудника может только администратор, а создать первого
     * администратора обычным путём невозможно — его Telegram ID
     * в момент установки ещё неизвестен.
     *
     * Окно закрывается навсегда с появлением первой учётной записи.
     */
    if (!user && ctx.from) {
      const [stats] = await db.select({ total: count() }).from(users);

      if (stats && stats.total === 0) {
        const [created] = await db
          .insert(users)
          .values({
            telegramId: String(ctx.from.id),
            telegramUsername: ctx.from.username?.toLowerCase() ?? null,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name ?? null,
            position: 'Администратор системы',
            role: 'admin',
            status: 'active',
            confirmedAt: new Date(),
          })
          .returning();

        if (created) {
          user = created;
          ctx.dbUser = created;
          pullAvatar(ctx.from.id, created.id);
          await ctx.reply(
            [
              'Система запущена, и ты в ней первый — значит, администратор.',
              '',
              'Дальше сотрудники добавляются через раздел «Команда»:',
              'достаточно имени и @username, Telegram ID подтянется сам,',
              'когда человек впервые откроет бота.',
            ].join('\n'),
          );
        }
      }
    }

    if (!user) {
      await ctx.reply(msg.notRegistered);
      await ctx.reply(`<code>${ctx.from?.id}</code>`, { parse_mode: 'HTML' });
      return;
    }

    if (user.status === 'disabled') {
      await ctx.reply('Доступ отключён. Обратись к администратору.');
      return;
    }

    /** Уже подтверждён — сразу в меню, без повторного вопроса о личности. */
    if (user.status === 'active' && user.confirmedAt) {
      await ctx.reply(msg.welcomeAfterConfirm(user.firstName, user.role !== 'employee'), {
        parse_mode: 'HTML',
        reply_markup: mainMenu(user.role),
      });
      return;
    }

    await ctx.reply(msg.identityConfirmation(user), {
      parse_mode: 'HTML',
      reply_markup: identityConfirm(),
    });
  });

  /* --------------------------------------------- Подтверждение личности */

  bot.callbackQuery('identity:yes', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return ctx.answerCallbackQuery('Профиль не найден');

    await db
      .update(users)
      .set({ status: 'active', confirmedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    if (ctx.from) pullAvatar(ctx.from.id, user.id);

    await ctx.answerCallbackQuery('Доступ открыт');
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply(msg.welcomeAfterConfirm(user.firstName, user.role !== 'employee'), {
      parse_mode: 'HTML',
      reply_markup: mainMenu(user.role),
    });
  });

  bot.callbackQuery('identity:no', async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return ctx.answerCallbackQuery();

    /**
     * Не удаляем карточку и не открываем доступ: помечаем как требующую
     * внимания администратора. Данные могли перепутать при заведении,
     * и потерять их здесь было бы хуже, чем подождать.
     */
    await db
      .update(users)
      .set({ status: 'pending', telegramId: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply(msg.identityRejected);
  });

  /* ------------------------------------------------- Переходы по задаче */

  const TRANSITION_BY_ACTION: Record<string, TaskStatus> = {
    ack: 'acknowledged',
    start: 'in_progress',
    submit: 'submitted',
    accept: 'done',
    reopen: 'in_progress',
  };

  bot.callbackQuery(/^task:(ack|start|submit|accept|reopen):(.+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return ctx.answerCallbackQuery('Профиль не найден');

    const action = ctx.match[1] as string;
    const taskId = ctx.match[2] as string;
    const target = TRANSITION_BY_ACTION[action];
    if (!target) return ctx.answerCallbackQuery();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return ctx.answerCallbackQuery('Задача не найдена');

    const verdict = checkTransition(task.status, target, {
      role: user.role,
      isAssignee: task.assigneeId === user.id,
      isAuthor: task.authorId === user.id,
    });

    if (!verdict.ok) {
      return ctx.answerCallbackQuery({ text: verdict.message, show_alert: true });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(tasks)
        .set({
          status: target,
          ...statusSideEffects(target, now),
          updatedAt: now,
          updatedSource: 'bot',
        })
        .where(eq(tasks.id, taskId));

      await tx.insert(taskEvents).values({
        taskId,
        actorId: user.id,
        type: target === 'acknowledged' ? 'acknowledged' : 'status_changed',
        payload: { from: task.status, to: target },
        source: 'bot',
      });
    });

    await ctx.answerCallbackQuery(
      target === 'acknowledged' ? 'Принято. Работаем.' : 'Статус обновлён',
    );

    /** Обновляем кнопки под тем же сообщением — новый статус, новые действия. */
    await ctx.editMessageReplyMarkup({
      reply_markup: taskActions(taskId, target, {
        isAssignee: task.assigneeId === user.id,
        canAccept: user.role !== 'employee' || task.authorId === user.id,
        webAppUrl,
      }),
    });
  });

  /**
   * «Застрял» требует текста причины, поэтому уводим человека в Mini App,
   * а не втягиваем в диалог из нескольких сообщений в чате.
   */
  bot.callbackQuery(/^task:block:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1] as string;
    await ctx.answerCallbackQuery();
    await ctx.reply('Опиши, что именно мешает — руководитель увидит это первым делом.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚧 Описать проблему', web_app: { url: `${webAppUrl}/task/${taskId}/block` } }],
        ],
      },
    });
  });

  /* ------------------------------------------------------------- Меню */

  const requireUser = (handler: (ctx: BotContext, user: NonNullable<BotContext['dbUser']>) => Promise<void>) =>
    async (ctx: BotContext) => {
      if (!ctx.dbUser || ctx.dbUser.status !== 'active') {
        await ctx.reply('Сначала нажми /start и подтверди профиль.');
        return;
      }
      await handler(ctx, ctx.dbUser);
    };

  /**
   * Каждый пункт меню отвечает по своей теме прямо в чате.
   *
   * Раньше все они открывали мини-приложение на одном и том же экране —
   * восемь разных подписей и одно действие. Посмотреть свой список нужно
   * уметь не выходя из переписки: это две секунды против запуска приложения.
   */
  type MenuHandler = (
    user: NonNullable<BotContext['dbUser']>,
  ) => Promise<string>;

  const MENU_ANSWERS: Record<string, MenuHandler> = {
    [MENU.myTasks]: (user) => views.myTasks(db, user.id, user.timezone),
    [MENU.today]: (user) => views.todayTasks(db, user.id, user.timezone),
    [MENU.deadlines]: (user) => views.deadlines(db, user.id, user.timezone),
    [MENU.team]: (user) => views.teamSummary(db, user.id, user.timezone),
    [MENU.projects]: (user) => views.projectsStatus(db, user.id),
    [MENU.notifications]: (user) => views.notificationSettings(db, user.id),
    [MENU.reports]: async () => views.reports(),
  };

  for (const [text, answer] of Object.entries(MENU_ANSWERS)) {
    bot.hears(
      text,
      requireUser(async (ctx, user) => {
        try {
          await ctx.reply(await answer(user), { parse_mode: 'HTML' });
        } catch (error) {
          console.error('Не удалось собрать ответ меню:', error);
          await ctx.reply('Не получилось собрать список. Попробуй ещё раз через минуту.');
        }
      }),
    );
  }

  bot.hears(MENU.help, async (ctx) => {
    await ctx.reply(msg.helpText, { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(msg.helpText, { parse_mode: 'HTML' });
  });

  /** Свой Telegram ID — то, что администратор попросит при заведении карточки. */
  bot.command('id', async (ctx) => {
    await ctx.reply(`Твой Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: 'HTML' });
  });

  /* ------------------------------------------------------------ Ошибки */

  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;

    if (e instanceof GrammyError) {
      console.error(`Telegram отклонил запрос (update ${ctx.update.update_id}):`, e.description);
    } else if (e instanceof HttpError) {
      console.error('Telegram недоступен:', e);
    } else {
      console.error(`Ошибка в обработчике (update ${ctx.update.update_id}):`, e);
    }
  });

  return bot;
}

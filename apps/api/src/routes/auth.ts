import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, or } from '@ostro/db';
import { authSessions, users } from '@ostro/db';
import { config } from '../config.js';
import { hashRefresh } from '../auth/jwt.js';
import { VALIDATION_MESSAGES, validateInitData } from '../auth/init-data.js';

/**
 * Вход в Mini App.
 *
 * Единственная точка, где мы доверяем данным Telegram, — и то лишь после того,
 * как подпись сошлась. Дальше приложение живёт на нашем собственном токене.
 */
export async function registerAuthRoutes(app: FastifyInstance) {
  app.post(
    '/telegram',
    {
      schema: {
        body: z.object({
          /** Сырая строка window.Telegram.WebApp.initData, без изменений. */
          initData: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { initData } = request.body as { initData: string };

      const result = validateInitData(initData, config.TELEGRAM_BOT_TOKEN);

      if (!result.ok) {
        /**
         * Причину отказа пишем в лог, но наружу отдаём одинаковый ответ:
         * подробности помогли бы подбирать подпись.
         */
        request.log.warn(
          { reason: result.reason, fields: result.fields },
          VALIDATION_MESSAGES[result.reason],
        );
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'Не удалось подтвердить вход через Telegram' },
        });
      }

      const tgUser = result.data.user;
      if (!tgUser) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'Telegram не передал профиль пользователя' },
        });
      }

      const telegramId = String(tgUser.id);
      const username = tgUser.username?.toLowerCase() ?? null;

      const [found] = await app.db
        .select()
        .from(users)
        .where(
          or(
            eq(users.telegramId, telegramId),
            username ? and(eq(users.telegramUsername, username), isNull(users.telegramId)) : undefined,
          ),
        )
        .limit(1);

      if (!found) {
        return reply.code(403).send({
          error: {
            code: 'not_registered',
            message: 'Тебя пока нет в списке команды. Попроси администратора добавить.',
          },
        });
      }

      if (found.status === 'disabled') {
        return reply
          .code(403)
          .send({ error: { code: 'disabled', message: 'Доступ отключён' } });
      }

      /** Карточку заводили по username — фиксируем ID при первом входе. */
      if (!found.telegramId) {
        await app.db
          .update(users)
          .set({ telegramId, updatedAt: new Date() })
          .where(eq(users.id, found.id));
      }

      const accessToken = await app.jwt.signAccess({
        sub: found.id,
        role: found.role,
        tg: telegramId,
      });

      const refresh = app.jwt.issueRefresh();
      await app.db.insert(authSessions).values({
        userId: found.id,
        refreshTokenHash: refresh.hash,
        userAgent: request.headers['user-agent'] ?? null,
        expiresAt: refresh.expiresAt,
      });

      return {
        accessToken,
        refreshToken: refresh.token,
        user: {
          id: found.id,
          telegramId: found.telegramId ?? telegramId,
          telegramUsername: found.telegramUsername,
          firstName: found.firstName,
          lastName: found.lastName,
          position: found.position,
          role: found.role,
          status: found.status,
          timezone: found.timezone,
          createdAt: found.createdAt.toISOString(),
        },
      };
    },
  );

  app.post(
    '/refresh',
    { schema: { body: z.object({ refreshToken: z.string().min(1) }) } },
    async (request, reply) => {
      const { refreshToken } = request.body as { refreshToken: string };

      const [session] = await app.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, hashRefresh(refreshToken)))
        .limit(1);

      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        return reply
          .code(401)
          .send({ error: { code: 'invalid_refresh', message: 'Сессия истекла' } });
      }

      const [user] = await app.db.select().from(users).where(eq(users.id, session.userId)).limit(1);
      if (!user || user.status !== 'active') {
        return reply.code(403).send({ error: { code: 'disabled', message: 'Доступ отключён' } });
      }

      const accessToken = await app.jwt.signAccess({
        sub: user.id,
        role: user.role,
        tg: user.telegramId ?? '',
      });

      return { accessToken };
    },
  );

  app.post(
    '/logout',
    { schema: { body: z.object({ refreshToken: z.string().min(1) }) } },
    async (request) => {
      const { refreshToken } = request.body as { refreshToken: string };
      await app.db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.refreshTokenHash, hashRefresh(refreshToken)));
      return { ok: true };
    },
  );
}

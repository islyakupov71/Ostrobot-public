import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from '@ostro/db';
import { projectMembers, users } from '@ostro/db';
import type { AccessContext } from '@ostro/core';
import type { ProjectRole } from '@ostro/shared';

/**
 * Проверка access-токена и сборка контекста доступа.
 *
 * Роли проектов подтягиваются здесь же: почти каждый маршрут спрашивает
 * «а этот проект вообще его?», и ходить за ответом в базу по второму разу
 * в каждом обработчике незачем.
 */

declare module 'fastify' {
  interface FastifyRequest {
    access?: AccessContext;
    currentUser?: typeof users.$inferSelect;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: { code: 'unauthorized', message: 'Нужен вход' } });
  }

  const claims = await request.server.jwt.verifyAccess(header.slice(7));
  if (!claims) {
    return reply
      .code(401)
      .send({ error: { code: 'token_expired', message: 'Сессия истекла, переоткрой приложение' } });
  }

  const [user] = await request.server.db
    .select()
    .from(users)
    .where(eq(users.id, claims.sub))
    .limit(1);

  if (!user || user.status !== 'active') {
    return reply.code(403).send({ error: { code: 'disabled', message: 'Доступ отключён' } });
  }

  const memberships = await request.server.db
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));

  request.currentUser = user;
  request.access = {
    role: user.role,
    userId: user.id,
    projectRoles: new Map(memberships.map((m) => [m.projectId, m.role as ProjectRole])),
  };
}

/** Обёртка для маршрутов, требующих конкретного права. */
export function requirePermission(check: (ctx: AccessContext) => boolean) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.access || !check(request.access)) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Недостаточно прав' } });
    }
  };
}

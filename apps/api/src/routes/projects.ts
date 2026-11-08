import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, ne, sql } from '@ostro/db';
import {
  procurementCategories,
  projectMembers,
  projects,
  quoteRequests,
  tasks,
  users,
} from '@ostro/db';
import { canAdminister } from '@ostro/core';
import { OPEN_TASK_STATUSES } from '@ostro/shared';
import { z } from 'zod';
import { authenticate } from '../plugins/authenticate.js';

/**
 * Проекты.
 *
 * Один проект — одно мероприятие или тендер. Всё остальное — задачи,
 * подрядчики, категории закупки, статус-таблица — принадлежит проекту
 * и живёт отдельно от соседних. Смешать данные двух тендеров нельзя
 * ни случайно, ни намеренно: связь по проекту стоит в каждом запросе.
 *
 * Заводит проекты руководитель, без участия разработчика: новые тендеры
 * появляются постоянно, и превращать это в задачу для программиста —
 * значит гарантированно получить систему, мимо которой работают.
 */

/** Категории закупки, с которых начинается любое мероприятие агентства. */
const DEFAULT_CATEGORIES = [
  'Площадки',
  'Ведущие',
  'Хореографы/кавергруппа',
  'Фотографы/видеографы',
  'Вокалисты',
  'Аниматоры',
  'Кейтеринг',
  'Печатная продукция',
  'Техничка',
  'Хэдлайнер',
];

const createSchema = z.object({
  name: z.string().min(2, 'Как называется мероприятие?').max(120),
  eventDate: z.string().datetime({ offset: true }).optional(),
  /**
   * Ссылка на статус-таблицу проекта — целиком, как её копируют из браузера.
   * Просить у человека «идентификатор книги» бессмысленно: он его не видит.
   */
  spreadsheetUrl: z.string().max(500).optional(),
  categories: z.array(z.string().min(1).max(80)).optional(),
});

/** Достаёт идентификатор книги из любой формы ссылки на Google-таблицу. */
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/.exec(trimmed);
  if (fromUrl?.[1]) return fromUrl[1];

  /** Иногда вставляют сразу идентификатор — он тоже подходит. */
  if (/^[a-zA-Z0-9-_]{30,}$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * Короткий код проекта.
 *
 * Из него собирается номер задачи вида DEMO-42 — им ссылаются в переписке,
 * поэтому он должен быть узнаваемым. Спрашивать код у человека незачем:
 * это лишнее поле в форме ради того, что выводится из названия.
 */
export function suggestKey(name: string, eventDate?: Date | null): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-ZА-ЯЁ0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));

  let base = words.length >= 2 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? 'PRJ').slice(0, 4);

  if (base.length < 2) base = 'PRJ';

  /** Год мероприятия разводит одноимённые тендеры разных лет. */
  const year = eventDate ? String(eventDate.getFullYear()).slice(2) : '';
  return `${base}${year}`;
}

export async function registerProjectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /* ------------------------------------------------------------- Список */

  app.get('/', async (request) => {
    const access = request.access!;
    const mine = [...access.projectRoles.keys()];

    /** Администратор видит все проекты, остальные — только свои. */
    const rows = await app.db
      .select({
        id: projects.id,
        key: projects.key,
        name: projects.name,
        eventDate: projects.eventDate,
        spreadsheetId: projects.spreadsheetId,
        isArchived: projects.isArchived,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(
        access.role === 'admin'
          ? eq(projects.isArchived, false)
          : and(eq(projects.isArchived, false), mine.length > 0 ? inArray(projects.id, mine) : sql`false`),
      )
      .orderBy(desc(projects.createdAt));

    if (rows.length === 0) return { items: [] };

    const ids = rows.map((r) => r.id);

    /** Счётчики считаются двумя запросами на все проекты, а не по одному на каждый. */
    const taskStats = await app.db
      .select({
        projectId: tasks.projectId,
        open: count(),
        overdue: sql<number>`count(*) filter (where ${tasks.deadlineAt} < now())::int`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
      .groupBy(tasks.projectId);

    const kpStats = await app.db
      .select({
        projectId: quoteRequests.projectId,
        total: count(),
        waiting: sql<number>`count(*) filter (where ${quoteRequests.status} in ('contacted','awaiting_quote'))::int`,
        received: sql<number>`count(*) filter (where ${quoteRequests.status} = 'received')::int`,
      })
      .from(quoteRequests)
      .where(inArray(quoteRequests.projectId, ids))
      .groupBy(quoteRequests.projectId);

    const tasksById = new Map(taskStats.map((s) => [s.projectId, s]));
    const kpById = new Map(kpStats.map((s) => [s.projectId, s]));

    return {
      items: rows.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        eventDate: p.eventDate?.toISOString() ?? null,
        hasSpreadsheet: Boolean(p.spreadsheetId),
        openTasks: tasksById.get(p.id)?.open ?? 0,
        overdueTasks: tasksById.get(p.id)?.overdue ?? 0,
        vendorsTotal: kpById.get(p.id)?.total ?? 0,
        vendorsWaiting: kpById.get(p.id)?.waiting ?? 0,
        vendorsReceived: kpById.get(p.id)?.received ?? 0,
      })),
    };
  });

  /* ----------------------------------------------------------- Создание */

  app.post('/', { schema: { body: createSchema } }, async (request, reply) => {
    const access = request.access!;
    if (!canAdminister(access)) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Создавать проекты может руководитель' } });
    }

    const body = request.body as z.infer<typeof createSchema>;
    const eventDate = body.eventDate ? new Date(body.eventDate) : null;

    let spreadsheetId: string | null = null;
    if (body.spreadsheetUrl?.trim()) {
      spreadsheetId = extractSpreadsheetId(body.spreadsheetUrl);
      if (!spreadsheetId) {
        return reply.code(422).send({
          error: {
            code: 'bad_link',
            message: 'Это не похоже на ссылку на Google-таблицу. Скопируй её из адресной строки целиком.',
          },
        });
      }
    }

    /**
     * Код подбирается автоматически. При совпадении к нему добавляется число:
     * два тендера «Новый год» разных лет должны различаться в номерах задач.
     */
    const base = suggestKey(body.name, eventDate);
    let key = base;
    for (let attempt = 2; attempt < 50; attempt++) {
      const [taken] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, key))
        .limit(1);
      if (!taken) break;
      key = `${base}-${attempt}`;
    }

    const created = await app.db.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({
          key,
          name: body.name.trim(),
          eventDate,
          spreadsheetId,
          statusSheetName: 'СТАТУС',
        })
        .returning();

      /**
       * В проект сразу заводится вся команда, а создатель становится ведущим.
       *
       * Иначе получается ловушка: руководитель создал тендер, открыл постановку
       * задачи — и увидел пустой список исполнителей, потому что формально
       * в проекте он один. Состав всегда можно сузить потом; начинать
       * с пустого — лишний шаг ровно там, где человек ждёт результата.
       */
      const team = await tx
        .select({ id: users.id })
        .from(users)
        .where(ne(users.status, 'disabled'));

      await tx
        .insert(projectMembers)
        .values(
          team.map((u) => ({
            projectId: project!.id,
            userId: u.id,
            role: u.id === access.userId ? ('lead' as const) : ('member' as const),
          })),
        )
        .onConflictDoNothing();

      const categories = body.categories?.length ? body.categories : DEFAULT_CATEGORIES;
      await tx.insert(procurementCategories).values(
        categories.map((name, i) => ({ projectId: project!.id, name, sortOrder: i })),
      );

      return project!;
    });

    reply.code(201);
    return {
      id: created.id,
      key: created.key,
      name: created.name,
      eventDate: created.eventDate?.toISOString() ?? null,
      hasSpreadsheet: Boolean(created.spreadsheetId),
      openTasks: 0,
      overdueTasks: 0,
      vendorsTotal: 0,
      vendorsWaiting: 0,
      vendorsReceived: 0,
    };
  });

  /* -------------------------------------------------- Состав участников */

  app.post(
    '/:id/members',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          userIds: z.array(z.string().uuid()).min(1),
          role: z.enum(['lead', 'member', 'observer']).default('member'),
        }),
      },
    },
    async (request, reply) => {
      const access = request.access!;
      if (!canAdminister(access)) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'Недостаточно прав' } });
      }

      const { id } = request.params as { id: string };
      const body = request.body as { userIds: string[]; role: 'lead' | 'member' | 'observer' };

      await app.db
        .insert(projectMembers)
        .values(body.userIds.map((userId) => ({ projectId: id, userId, role: body.role })))
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.userId],
          set: { role: body.role },
        });

      return { ok: true, added: body.userIds.length };
    },
  );
}

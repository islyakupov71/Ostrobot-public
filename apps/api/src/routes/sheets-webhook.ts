import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Приём правок из Google-таблицы.
 *
 * Apps Script вешается на onEdit и стучится сюда при каждой правке —
 * это даёт почти мгновенную реакцию вместо ожидания следующего опроса.
 * Опрос при этом никуда не девается: Apps Script умеет молча падать
 * по своим квотам, и полный проход раз в несколько минут остаётся
 * страховкой, а не основным механизмом.
 */

const editEventSchema = z.object({
  spreadsheetId: z.string(),
  sheetName: z.string(),
  row: z.number().int().positive(),
  /** Значения всей строки — разбираем их тем же кодом, что и при полном синке. */
  values: z.array(z.unknown()),
  editedAt: z.string(),
});

export async function registerSheetsWebhook(app: FastifyInstance) {
  app.post(
    '/sheets',
    { schema: { body: editEventSchema } },
    async (request, reply) => {
      /**
       * Общий секрет вместо подписи: Apps Script не умеет считать HMAC
       * без заметных приседаний, а канал и так HTTPS. Сравнение —
       * за постоянное время, чтобы секрет нельзя было подобрать по таймингам.
       */
      const provided = request.headers['x-ostro-secret'];
      const expected = config.SHEETS_WEBHOOK_SECRET;

      if (!expected || typeof provided !== 'string') {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Нет секрета' } });
      }

      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Секрет не подошёл' } });
      }

      const event = request.body as z.infer<typeof editEventSchema>;

      /**
       * Обработку не делаем прямо здесь: Apps Script ждёт ответа и имеет
       * свой таймаут, а разбор строки может потребовать похода в базу
       * за пользователем и созданием задачи. Ставим в очередь и отвечаем сразу.
       */
      request.log.info(
        { sheet: event.sheetName, row: event.row },
        'Правка в таблице принята в очередь',
      );

      // TODO(worker): app.boss.send('sheets.row-changed', event)

      return reply.code(202).send({ accepted: true });
    },
  );
}

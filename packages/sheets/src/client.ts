import { google, type sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { DRIVE_SCOPES } from './drive.js';

/**
 * Клиент Google Sheets.
 *
 * Google даёт 60 запросов в минуту на сервис-аккаунт и 300 на проект.
 * Наивный код, читающий лист на каждое нажатие кнопки, упирается в эту стену
 * за пару минут работы команды — и упирается тихо, отдавая 429 вместо данных.
 * Поэтому здесь всё, что можно, идёт батчами, а на 429 и 5xx работает
 * экспоненциальный откат.
 */

export type SheetsClientOptions = {
  serviceAccountEmail: string;
  privateKey: string;
  spreadsheetId: string;
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

export class SheetsClient {
  private readonly api: sheets_v4.Sheets;
  readonly spreadsheetId: string;

  constructor(options: SheetsClientOptions) {
    const auth = new JWT({
      email: options.serviceAccountEmail,
      /** В .env ключ хранится одной строкой, переносы записаны как \n. */
      key: options.privateKey.replace(/\\n/g, '\n'),
      /**
       * Тот же набор прав, что у DriveClient. Одного `spreadsheets` мало:
       * без доступа к Диску нельзя ни создать таблицу под новый тендер,
       * ни увидеть файлы КП, которые присылают подрядчики.
       */
      scopes: DRIVE_SCOPES,
    });

    this.api = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = options.spreadsheetId;
  }

  /**
   * Повтор с экспоненциальным откатом и джиттером.
   * Джиттер важен: без него все воркеры, получившие 429 одновременно,
   * повторят запрос тоже одновременно и снова получат 429.
   */
  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const status = (error as { code?: number; status?: number }).code
          ?? (error as { status?: number }).status;

        if (!status || !RETRYABLE_STATUS.has(status) || attempt === MAX_ATTEMPTS - 1) {
          throw error;
        }

        const backoff = 2 ** attempt * 500 + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw new Error(`Google Sheets: ${operation} не удался после ${MAX_ATTEMPTS} попыток`, {
      cause: lastError,
    });
  }

  /** Прочитать диапазон целиком. Пустые хвостовые ячейки Google не возвращает. */
  async readRange(range: string): Promise<unknown[][]> {
    const response = await this.withRetry(`чтение ${range}`, () =>
      this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      }),
    );
    return (response.data.values ?? []) as unknown[][];
  }

  /**
   * Записать несколько несмежных диапазонов одним запросом.
   *
   * Ключевая экономия квоты: обновление сорока задач — это один вызов,
   * а не сорок. Все записи из очереди синка собираются сюда.
   */
  async batchUpdate(updates: { range: string; values: unknown[][] }[]): Promise<void> {
    if (updates.length === 0) return;

    await this.withRetry(`пакетная запись ${updates.length} диапазонов`, () =>
      this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates.map((u) => ({ range: u.range, values: u.values as never })),
        },
      }),
    );
  }

  /** Дописать строки в конец листа — так в таблице появляются задачи, созданные в боте. */
  async appendRows(sheetName: string, rows: unknown[][]): Promise<number | null> {
    if (rows.length === 0) return null;

    const response = await this.withRetry(`добавление ${rows.length} строк`, () =>
      this.api.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:A`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows as never },
      }),
    );

    /** Из ответа вида «Задачи!A57:K58» достаём номер первой добавленной строки. */
    const updatedRange = response.data.updates?.updatedRange;
    const match = updatedRange ? /![A-Z]+(\d+)/.exec(updatedRange) : null;
    return match?.[1] ? Number(match[1]) : null;
  }

  /** Названия листов книги — нужны, чтобы проверить настройки проекта при старте. */
  async listSheetNames(): Promise<string[]> {
    const response = await this.withRetry('чтение структуры книги', () =>
      this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties' }),
    );
    return (response.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t));
  }

  /** Проверка доступа при старте: понятная ошибка лучше, чем падение в первом же синке. */
  async verifyAccess(): Promise<{ ok: true; sheets: string[] } | { ok: false; reason: string }> {
    try {
      const sheets = await this.listSheetNames();
      return { ok: true, sheets };
    } catch (error) {
      const status = (error as { code?: number }).code;
      if (status === 403) {
        return {
          ok: false,
          reason:
            'Нет доступа к таблице. Открой её и поделись с email сервис-аккаунта, дав право «Редактор».',
        };
      }
      if (status === 404) {
        return { ok: false, reason: 'Таблица не найдена — проверь GOOGLE_SPREADSHEET_ID.' };
      }
      return { ok: false, reason: (error as Error).message };
    }
  }
}

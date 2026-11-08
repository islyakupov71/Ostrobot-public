import { google, type drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';

/**
 * Работа с Google Диском.
 *
 * Нужна ради двух вещей, которых не даёт один Sheets API.
 *
 * Первая — заводить рабочее пространство нового тендера: папку с подпапками
 * по категориям закупки и таблицу, скопированную с шаблона. Вручную это
 * полдня работы, которая каждый раз делается чуть по-разному, и уже через
 * три тендера структура папок расходится настолько, что искать в них
 * невозможно.
 *
 * Вторая — замечать файлы, которые подрядчики присылают. Когда смету
 * кладут в папку категории, бот видит новый файл, сам меняет статус
 * на «КП получено» и цепляет ссылку к строке подрядчика. Ручной шаг
 * «не забыть отметить в таблице» исчезает целиком.
 */

export type DriveOptions = {
  serviceAccountEmail: string;
  privateKey: string;
};

/**
 * Права доступа.
 *
 * `drive.file` дал бы доступ только к файлам, созданным самим ботом —
 * этого мало: работать нужно и с таблицами, которые команда завела до нас.
 * Поэтому берётся полный `drive`, но реально бот видит лишь то,
 * что ему открыли: доступ выдаётся на стороне Google, а не здесь.
 */
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

const MIME = {
  folder: 'application/vnd.google-apps.folder',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
} as const;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export type ProjectWorkspace = {
  folderId: string;
  folderUrl: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  categoryFolders: { name: string; id: string }[];
};

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  createdTime: string;
  modifiedTime: string;
  sizeBytes: number | null;
};

export class DriveClient {
  private readonly api: drive_v3.Drive;

  constructor(options: DriveOptions) {
    const auth = new JWT({
      email: options.serviceAccountEmail,
      key: options.privateKey.replace(/\\n/g, '\n'),
      scopes: DRIVE_SCOPES,
    });

    this.api = google.drive({ version: 'v3', auth });
  }

  private async withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const status = (error as { code?: number }).code;
        if (!status || !RETRYABLE.has(status) || attempt === 4) throw error;
        /** Джиттер обязателен: без него все воркеры повторят запрос разом. */
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500 + Math.random() * 500));
      }
    }

    throw new Error(`Google Drive: ${what} не удался`, { cause: lastError });
  }

  /**
   * Проверка доступа при старте.
   *
   * Отдельный метод, потому что 403 от Google выглядит одинаково
   * и когда не включён Drive API, и когда папку забыли расшарить, —
   * а чинится это совершенно по-разному.
   */
  async verifyFolderAccess(
    folderId: string,
  ): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
    try {
      const res = await this.api.files.get({
        fileId: folderId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true,
      });

      if (res.data.mimeType !== MIME.folder) {
        return { ok: false, reason: 'Указанный объект — не папка, а файл.' };
      }
      return { ok: true, name: res.data.name ?? '' };
    } catch (error) {
      const status = (error as { code?: number }).code;
      const message = (error as Error).message ?? '';

      if (message.includes('Drive API has not been used') || message.includes('accessNotConfigured')) {
        return {
          ok: false,
          reason: 'В Google Cloud не включён Drive API. Включи его в разделе APIs & Services → Library.',
        };
      }
      if (status === 403) {
        return {
          ok: false,
          reason: 'Нет доступа к папке. Открой её служебному аккаунту с правом «Редактор».',
        };
      }
      if (status === 404) {
        return { ok: false, reason: 'Папка не найдена — проверь её идентификатор.' };
      }
      return { ok: false, reason: message };
    }
  }

  /** Ищет папку с таким именем внутри родительской; создаёт, если нет. */
  async ensureFolder(name: string, parentId: string): Promise<string> {
    const escaped = name.replace(/'/g, "\\'");
    const found = await this.withRetry(`поиск папки «${name}»`, () =>
      this.api.files.list({
        q: `name = '${escaped}' and mimeType = '${MIME.folder}' and '${parentId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );

    const existing = found.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await this.withRetry(`создание папки «${name}»`, () =>
      this.api.files.create({
        requestBody: { name, mimeType: MIME.folder, parents: [parentId] },
        fields: 'id',
        supportsAllDrives: true,
      }),
    );

    const id = created.data.id;
    if (!id) throw new Error(`Не удалось создать папку «${name}»`);
    return id;
  }

  /**
   * Разворачивает рабочее пространство нового тендера.
   *
   * Порядок важен: сначала папка мероприятия, потом таблица внутри неё,
   * потом подпапки категорий. Если что-то сорвётся на середине, повторный
   * запуск не наплодит дублей — и папки, и таблица ищутся по имени
   * перед созданием.
   */
  async createProjectWorkspace(params: {
    rootFolderId: string;
    projectName: string;
    templateSpreadsheetId?: string;
    categories: readonly string[];
  }): Promise<ProjectWorkspace> {
    const folderId = await this.ensureFolder(params.projectName, params.rootFolderId);

    const spreadsheetName = `${params.projectName} — статус-таблица`;
    let spreadsheetId = await this.findFile(spreadsheetName, folderId, MIME.spreadsheet);

    if (!spreadsheetId) {
      spreadsheetId = params.templateSpreadsheetId
        ? await this.copyFile(params.templateSpreadsheetId, spreadsheetName, folderId)
        : await this.createSpreadsheet(spreadsheetName, folderId);
    }

    const categoryFolders: { name: string; id: string }[] = [];
    for (const name of params.categories) {
      categoryFolders.push({ name, id: await this.ensureFolder(name, folderId) });
    }

    return {
      folderId,
      folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
      spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      categoryFolders,
    };
  }

  private async findFile(name: string, parentId: string, mimeType: string): Promise<string | null> {
    const escaped = name.replace(/'/g, "\\'");
    const res = await this.withRetry(`поиск «${name}»`, () =>
      this.api.files.list({
        q: `name = '${escaped}' and mimeType = '${mimeType}' and '${parentId}' in parents and trashed = false`,
        fields: 'files(id)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    return res.data.files?.[0]?.id ?? null;
  }

  private async copyFile(sourceId: string, name: string, parentId: string): Promise<string> {
    const res = await this.withRetry(`копирование шаблона в «${name}»`, () =>
      this.api.files.copy({
        fileId: sourceId,
        requestBody: { name, parents: [parentId] },
        fields: 'id',
        supportsAllDrives: true,
      }),
    );
    const id = res.data.id;
    if (!id) throw new Error('Не удалось скопировать шаблон таблицы');
    return id;
  }

  private async createSpreadsheet(name: string, parentId: string): Promise<string> {
    const res = await this.withRetry(`создание таблицы «${name}»`, () =>
      this.api.files.create({
        requestBody: { name, mimeType: MIME.spreadsheet, parents: [parentId] },
        fields: 'id',
        supportsAllDrives: true,
      }),
    );
    const id = res.data.id;
    if (!id) throw new Error('Не удалось создать таблицу');
    return id;
  }

  /**
   * Файлы в папке категории — те самые КП от подрядчиков.
   *
   * Папки исключаются, удалённые тоже. Сортировка по времени создания,
   * чтобы синхронизатор мог запрашивать только появившееся с прошлого раза.
   */
  async listFiles(folderId: string, since?: Date): Promise<DriveFile[]> {
    const clauses = [
      `'${folderId}' in parents`,
      `mimeType != '${MIME.folder}'`,
      'trashed = false',
    ];
    if (since) clauses.push(`createdTime > '${since.toISOString()}'`);

    const res = await this.withRetry(`чтение папки ${folderId}`, () =>
      this.api.files.list({
        q: clauses.join(' and '),
        fields: 'files(id, name, mimeType, webViewLink, createdTime, modifiedTime, size)',
        orderBy: 'createdTime',
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );

    return (res.data.files ?? []).map((f) => ({
      id: f.id!,
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
      createdTime: f.createdTime ?? '',
      modifiedTime: f.modifiedTime ?? '',
      sizeBytes: f.size ? Number(f.size) : null,
    }));
  }

  /** Все таблицы внутри папки — чтобы подхватить уже заведённые команде вручную. */
  async listSpreadsheets(folderId: string): Promise<DriveFile[]> {
    const res = await this.withRetry(`поиск таблиц в ${folderId}`, () =>
      this.api.files.list({
        q: `'${folderId}' in parents and mimeType = '${MIME.spreadsheet}' and trashed = false`,
        fields: 'files(id, name, mimeType, webViewLink, createdTime, modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );

    return (res.data.files ?? []).map((f) => ({
      id: f.id!,
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      webViewLink: f.webViewLink ?? '',
      createdTime: f.createdTime ?? '',
      modifiedTime: f.modifiedTime ?? '',
      sizeBytes: null,
    }));
  }

  /**
   * Открыть доступ человеку.
   *
   * Файлы, созданные ботом, принадлежат служебному аккаунту — люди увидят
   * их, только если папка расшарена или доступ выдан явно. Вызывается
   * при заведении проекта для участников команды.
   */
  async share(
    fileId: string,
    email: string,
    role: 'reader' | 'writer' = 'writer',
  ): Promise<void> {
    await this.withRetry(`выдача доступа ${email}`, () =>
      this.api.permissions.create({
        fileId,
        requestBody: { type: 'user', role, emailAddress: email },
        /** Уведомление по почте не шлём: люди узнают о проекте из бота. */
        sendNotificationEmail: false,
        supportsAllDrives: true,
      }),
    );
  }

  /**
   * Угадывает, к какому подрядчику относится присланный файл.
   *
   * Смету называют как придётся: «КП Атмосфера.pdf», «atmosfera_smeta.xlsx»,
   * «Коммерческое предложение — Loft Hall.pdf». Сопоставляем по вхождению
   * имени подрядчика в имя файла, отбрасывая регистр и служебные слова.
   * Совпадений может не быть — тогда файл просто останется без привязки,
   * и человек свяжет его руками. Ошибочная привязка хуже отсутствующей.
   */
  static matchVendor(
    fileName: string,
    vendors: readonly { id: string; name: string }[],
  ): { id: string; name: string } | null {
    const cleaned = fileName
      .toLowerCase()
      .replace(/\.(pdf|xlsx?|docx?|jpe?g|png|zip|rar)$/i, '')
      .replace(/\b(кп|смета|коммерческое|предложение|прайс)\b/g, ' ')
      .replace(/[_\-—–]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length < 3) return null;

    /** Самое длинное совпадение вернее короткого: «Loft Hall» точнее «Loft». */
    let best: { id: string; name: string } | null = null;
    for (const vendor of vendors) {
      const needle = vendor.name.toLowerCase().trim();
      if (needle.length < 3) continue;
      if (cleaned.includes(needle) && (!best || needle.length > best.name.length)) {
        best = vendor;
      }
    }

    return best;
  }
}

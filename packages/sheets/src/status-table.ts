import type { KpStatus } from '@ostro/shared';
import { rowHash } from './mapping.js';

/**
 * Разбор статус-таблицы подрядчиков.
 *
 * Написан под реальный лист агентства, а не под идеальную схему. Лист устроен
 * так: строка, где заполнено только «Наименование», — это заголовок категории
 * («Площадки», «Ведущие»), всё под ней до следующего заголовка относится к ней.
 * Контакты, ссылка и телефон свалены в одну ячейку в свободной форме,
 * стоимость записана прозой («7 100 000 руб (с учетом налога)»),
 * а статусы набраны с разным регистром и висячими пробелами.
 *
 * Всё это разбирается здесь, потому что заставлять команду вести таблицу
 * «правильно» — верный способ добиться, чтобы её перестали вести вообще.
 */

/** Колонки листа в том порядке, в каком они идут сейчас. */
export const STATUS_TABLE_COLUMNS = {
  name: 0,
  contacts: 1,
  address: 2,
  reserved: 3,
  status: 4,
  terms: 5,
  amount: 6,
  note: 7,
  responsible: 8,
} as const;

export const STATUS_TABLE_HEADERS = [
  'Наименование',
  'Контакты',
  'Адрес',
  'Столбец 1',
  'Статус по КП',
  'Условия',
  'Стоимость',
  'ВАЖНО',
  'Ответственный',
];

function norm(v: unknown): string {
  return String(v ?? '')
    .replace(/­/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Статус из ячейки.
 *
 * Формулировки взяты из живого листа. Список синонимов будет расти —
 * всё, что не разобралось, попадает в предупреждения синка, а не теряется.
 */
const STATUS_MAP: Record<string, KpStatus> = {
  '': 'new',
  'не связывались': 'new',

  'ожидаю ответ': 'contacted',
  'ожидаю ответа': 'contacted',
  'написала': 'contacted',
  'написали': 'contacted',
  'отправлен запрос': 'contacted',

  'ожидаю кп': 'awaiting_quote',
  'жду кп': 'awaiting_quote',
  'обещали прислать': 'awaiting_quote',

  'кп получено': 'received',
  'кп получен': 'received',
  'получено кп': 'received',
  'есть кп': 'received',

  'в коротком списке': 'shortlisted',
  'шорт-лист': 'shortlisted',
  'подходит': 'shortlisted',

  'не подходит': 'rejected',
  'отклонено': 'rejected',

  'отказ в сотрудничестве': 'declined',
  'отказ': 'declined',
  'отказались': 'declined',

  'выбран': 'selected',
  'выбрана': 'selected',
  'утверждён': 'selected',
};

export function parseStatus(raw: unknown): KpStatus | null {
  return STATUS_MAP[norm(raw)] ?? null;
}

/**
 * Пометки в колонке ВАЖНО, означающие отсев.
 *
 * В таблице у восьми подрядчиков стоит «КП получено», а рядом «НЕ ПОДХОДИТ
 * ПО ВМЕСТИМОСТИ» — то есть смета есть, но вариант уже отброшен. Для человека
 * это очевидно, для сводки «сколько КП собрано» — нет: она насчитает
 * несуществующие варианты. Здесь эти случаи распознаются и переводятся
 * в отдельный статус.
 */
const REJECTION_MARKERS = [
  'не подходит',
  'не соответствует',
  'не сядет',
  'не поместится',
  'не влезает',
  'занята в указанные даты',
  'перестала функционировать',
];

export function looksRejected(note: unknown): boolean {
  const text = norm(note);
  if (!text) return false;
  return REJECTION_MARKERS.some((m) => text.includes(m));
}

/**
 * Сумма из ячейки.
 *
 * Пишут по-разному: «7 100 000 руб (с учетом налога)», «от 250 000»,
 * «Сайт-приглашение: 60 000 руб». Берём первое число длиной от четырёх цифр —
 * более короткие почти всегда оказываются процентом налога или числом гостей.
 */
export function parseAmount(raw: unknown): number | null {
  const text = String(raw ?? '').replace(/ /g, ' ');
  if (!text.trim()) return null;

  const match = /(\d[\d\s.,]{3,})/.exec(text);
  if (!match?.[1]) return null;

  const digits = match[1].replace(/[\s.,]/g, '');
  const value = Number(digits);

  return Number.isFinite(value) && value >= 1000 ? value : null;
}

/** Ссылка на сайт подрядчика, если она есть внутри ячейки контактов. */
export function extractWebsite(contacts: unknown): string | null {
  const match = /https?:\/\/[^\s,;]+/.exec(String(contacts ?? ''));
  return match?.[0] ?? null;
}

export type ParsedVendorRow = {
  rowNumber: number;
  category: string | null;
  name: string;
  contacts: string | null;
  website: string | null;
  address: string | null;
  status: KpStatus;
  amount: number | null;
  terms: string | null;
  note: string | null;
  responsibleRaw: string | null;
  hash: string;
  warnings: string[];
};

export type ParsedStatusTable = {
  categories: string[];
  rows: ParsedVendorRow[];
  warnings: string[];
};

/**
 * Разбирает лист целиком, восстанавливая принадлежность строк к категориям.
 *
 * Категория не хранится в строке — она задаётся заголовком выше, поэтому
 * порядок строк здесь несёт данные, и читать лист вразнобой нельзя.
 */
export function parseStatusTable(
  values: readonly (readonly unknown[])[],
  firstDataRow = 2,
): ParsedStatusTable {
  const categories: string[] = [];
  const rows: ParsedVendorRow[] = [];
  const warnings: string[] = [];

  let currentCategory: string | null = null;

  for (const [offset, raw] of values.entries()) {
    const rowNumber = firstDataRow + offset;
    const cells = [...raw];
    const at = (i: number) => String(cells[i] ?? '').trim();

    const name = at(STATUS_TABLE_COLUMNS.name);
    const restFilled = cells.slice(1).some((c) => String(c ?? '').trim() !== '');

    if (!name && !restFilled) continue;

    /** Заголовок категории: имя есть, остальные ячейки пустые. */
    if (name && !restFilled) {
      currentCategory = name;
      categories.push(name);
      continue;
    }

    if (!name) {
      warnings.push(`Строка ${rowNumber}: есть данные, но нет названия подрядчика`);
      continue;
    }

    const rowWarnings: string[] = [];
    const statusRaw = at(STATUS_TABLE_COLUMNS.status);
    const note = at(STATUS_TABLE_COLUMNS.note);

    let status = parseStatus(statusRaw);
    if (status === null) {
      rowWarnings.push(`не понял статус «${statusRaw}»`);
      status = 'new';
    }

    /** Смета есть, но в заметке сказано, что вариант не годится. */
    if (status === 'received' && looksRejected(note)) {
      status = 'rejected';
    }
    if (status === 'declined' && !note) {
      rowWarnings.push('отказ без причины — непонятно, можно ли вернуться позже');
    }

    const contacts = at(STATUS_TABLE_COLUMNS.contacts);

    rows.push({
      rowNumber,
      category: currentCategory,
      name,
      contacts: contacts || null,
      website: extractWebsite(contacts),
      address: at(STATUS_TABLE_COLUMNS.address) || null,
      status,
      amount: parseAmount(at(STATUS_TABLE_COLUMNS.amount)),
      terms: at(STATUS_TABLE_COLUMNS.terms) || null,
      note: note || null,
      responsibleRaw: at(STATUS_TABLE_COLUMNS.responsible) || null,
      hash: rowHash(cells),
      warnings: rowWarnings,
    });

    warnings.push(...rowWarnings.map((w) => `Строка ${rowNumber} (${name}): ${w}`));
  }

  return { categories, rows, warnings };
}

/**
 * Сколько дней подрядчик молчит.
 *
 * Главная метрика воронки: именно по ней бот решает, кому пора напомнить,
 * и по ней же сортируется список у менеджера.
 */
export function silentDays(
  request: { status: KpStatus; requestedAt: Date | null; respondedAt: Date | null },
  now: Date = new Date(),
): number | null {
  if (request.status !== 'contacted' && request.status !== 'awaiting_quote') return null;

  const since = request.respondedAt ?? request.requestedAt;
  if (!since) return null;

  return Math.floor((now.getTime() - since.getTime()) / 86_400_000);
}

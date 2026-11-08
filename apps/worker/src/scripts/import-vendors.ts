import 'dotenv/config';
import postgres from 'postgres';
import { SheetsClient, parseStatusTable } from '@ostro/sheets';

/**
 * Импорт подрядчиков из статус-таблицы.
 *
 * Запускается один раз при подключении проекта к существующей таблице.
 * Дальше расхождения подбирает обычная синхронизация — но первый заход
 * особенный: строк почти двести, названия листов и колонок у каждого
 * агентства свои, и прогонять такое вслепую нельзя.
 *
 * Поэтому по умолчанию скрипт ничего не пишет, а показывает, что получится.
 * Запись включается явным флагом.
 *
 *   node import-vendors.mjs                 — только показать
 *   node import-vendors.mjs --apply         — записать в базу
 *   node import-vendors.mjs --sheet СТАТУС  — другой лист
 */

const args = process.argv.slice(2);

/**
 * Значение флага.
 *
 * Через indexOf напрямую делать нельзя: когда флага нет, indexOf вернёт −1,
 * и `args[-1 + 1]` молча отдаст первый аргумент. Именно так «--project»
 * без значения превратился в имя проекта «--sheet».
 */
function flag(name: string, fallback: string): string {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const APPLY = args.includes('--apply');
const SHEET = flag('--sheet', 'СТАТУС');
const PROJECT_KEY = flag('--project', 'DEMO');

const {
  DATABASE_URL,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SPREADSHEET_ID,
} = process.env;

if (!DATABASE_URL || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SPREADSHEET_ID) {
  console.error('Не хватает настроек. Нужны DATABASE_URL и три переменных GOOGLE_*.');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 2 });

const client = new SheetsClient({
  serviceAccountEmail: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  privateKey: GOOGLE_PRIVATE_KEY,
  spreadsheetId: GOOGLE_SPREADSHEET_ID,
});

/* ------------------------------------------------------------ Чтение листа */

console.log(`Читаю лист «${SHEET}»…`);
const values = await client.readRange(`${SHEET}!A2:I`);
const parsed = parseStatusTable(values, 2);

console.log(`Строк с данными: ${parsed.rows.length}`);
console.log(`Категорий: ${parsed.categories.length}\n`);

/* ------------------------------------------------------------- Что нашлось */

const byStatus = new Map<string, number>();
const byOwner = new Map<string, number>();
for (const r of parsed.rows) {
  byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const owner = r.responsibleRaw ?? '(не указан)';
  byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
}

console.log('По статусам:');
for (const [k, v] of [...byStatus].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

console.log('\nПо ответственным:');
for (const [k, v] of [...byOwner].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

console.log('\nКатегории:');
for (const c of parsed.categories) {
  const n = parsed.rows.filter((r) => r.category === c).length;
  console.log(`  ${String(n).padStart(4)}  ${c}`);
}

const withPrice = parsed.rows.filter((r) => r.amount !== null);
console.log(`\nСо стоимостью: ${withPrice.length}`);
for (const r of withPrice.slice(0, 5)) {
  console.log(`  ${r.name} — ${r.amount?.toLocaleString('ru-RU')} ₽`);
}

if (parsed.warnings.length > 0) {
  console.log(`\nЗамечания (${parsed.warnings.length}), первые 10:`);
  for (const w of parsed.warnings.slice(0, 10)) console.log(`  · ${w}`);
}

if (!APPLY) {
  console.log('\n— Это предварительный просмотр, база не тронута.');
  console.log('  Чтобы записать, запусти с флагом --apply');
  await sql.end();
  process.exit(0);
}

/* -------------------------------------------------------------- Запись */

const [project] = await sql`select id, key from projects where key = ${PROJECT_KEY}`;
if (!project) {
  console.error(`\nПроект с кодом «${PROJECT_KEY}» не найден. Создай его перед импортом.`);
  await sql.end();
  process.exit(1);
}

console.log(`\nПишу в проект ${project.key}…`);

/** Категории: порядок берётся из листа — он несёт смысл. */
const categoryIds = new Map<string, string>();
for (const [i, name] of parsed.categories.entries()) {
  const [row] = await sql`
    insert into procurement_categories (project_id, name, sort_order)
    values (${project.id}, ${name}, ${i})
    on conflict (project_id, name) do update set sort_order = ${i}
    returning id
  `;
  categoryIds.set(name, row!.id);
}
console.log(`  категорий: ${categoryIds.size}`);

/**
 * Сотрудников сопоставляем по имени из колонки «Ответственный».
 * Кого нет в системе — оставляем без ответственного: заводить людей
 * по строке таблицы опасно, опечатка превратится в лишнюю учётную запись.
 */
const people = (await sql`
  select id, first_name from users where status != 'disabled'
`) as unknown as { id: string; first_name: string }[];

const peopleByName = new Map(people.map((p) => [p.first_name.toLowerCase().trim(), p.id]));

let created = 0;
let updated = 0;
let noOwner = 0;

for (const row of parsed.rows) {
  const [vendor] = await sql`
    insert into vendors (name, website, contacts, address, kind)
    values (${row.name}, ${row.website}, ${row.contacts}, ${row.address}, ${row.category})
    on conflict (lower(name)) do update
      set contacts = coalesce(excluded.contacts, vendors.contacts),
          address  = coalesce(excluded.address, vendors.address),
          updated_at = now()
    returning id
  `;

  const ownerId = row.responsibleRaw
    ? (peopleByName.get(row.responsibleRaw.toLowerCase().trim()) ?? null)
    : null;
  if (row.responsibleRaw && !ownerId) noOwner++;

  /**
   * Момент запроса восстанавливаем приблизительно: в таблице его нет,
   * а без него нельзя считать дни молчания. Берём дату создания строки
   * как неизвестную и ставим текущий момент — со следующего дня счёт
   * пойдёт честно.
   */
  const requestedAt = row.status === 'new' ? null : new Date();

  const result = await sql`
    insert into quote_requests
      (project_id, category_id, vendor_id, status, responsible_id,
       amount, terms, note, requested_at, sheet_row, sheet_hash,
       sheet_synced_at, updated_source)
    values
      (${project.id},
       ${row.category ? (categoryIds.get(row.category) ?? null) : null},
       ${vendor!.id}, ${row.status}, ${ownerId},
       ${row.amount}, ${row.terms}, ${row.note}, ${requestedAt},
       ${row.rowNumber}, ${row.hash}, now(), 'sheets')
    on conflict (project_id, vendor_id) do update
      set status = excluded.status,
          amount = coalesce(excluded.amount, quote_requests.amount),
          terms = excluded.terms,
          note = excluded.note,
          responsible_id = coalesce(excluded.responsible_id, quote_requests.responsible_id),
          sheet_row = excluded.sheet_row,
          sheet_hash = excluded.sheet_hash,
          sheet_synced_at = now(),
          updated_at = now()
    returning (xmax = 0) as inserted
  `;

  if (result[0]?.inserted) created++;
  else updated++;
}

console.log(`  подрядчиков создано: ${created}`);
console.log(`  обновлено: ${updated}`);
if (noOwner > 0) {
  console.log(`  без ответственного: ${noOwner} (нет такого человека в системе)`);
}

console.log('\nГотово.');
await sql.end();

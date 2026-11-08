import 'dotenv/config';
import postgres from 'postgres';

/**
 * Заведение сотрудников.
 *
 * Telegram ID не нужен: карточка создаётся по юзернейму, а настоящий
 * идентификатор бот подставит сам, когда человек впервые нажмёт «Начать».
 * Так администратору не приходится выпрашивать у каждого его числовой ID —
 * шаг, на котором обычно всё и застревает.
 *
 * Повторный запуск обновляет существующие карточки, а не плодит новые.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Не задан DATABASE_URL');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 2 });

type Person = {
  firstName: string;
  username: string;
  position: string;
  role: 'employee' | 'manager' | 'admin';
};

const teamFile = process.argv[2];
if (!teamFile) {
  console.error('Передай путь к локальному JSON со списком сотрудников. Пример: examples/team.example.json');
  process.exit(1);
}
const { readFile } = await import('node:fs/promises');
const TEAM: Person[] = JSON.parse(await readFile(teamFile, 'utf8'));
if (!Array.isArray(TEAM) || TEAM.some((p) =>
  !p.firstName?.trim() || !/^[a-zA-Z0-9_]{5,32}$/.test(p.username ?? '') ||
  !['employee', 'manager', 'admin'].includes(p.role)
)) {
  throw new Error('Нужен массив с firstName, username и допустимой role. Пустые usernames из примера нужно заполнить локально.');
}

const [project] = await sql`select id, key from projects where key = 'DEMO'`;

for (const p of TEAM) {
  const username = p.username.toLowerCase().replace(/^@/, '');

  const [user] = await sql`
    insert into users (telegram_username, first_name, position, role, status)
    values (${username}, ${p.firstName}, ${p.position}, ${p.role}, 'pending')
    -- Индекс по юзернейму частичный: он покрывает только строки, где
    -- юзернейм задан. ON CONFLICT обязан повторить это условие дословно,
    -- иначе Postgres не понимает, какое ограничение имеется в виду.
    on conflict (lower(telegram_username)) where telegram_username is not null do update
      set first_name = excluded.first_name,
          position   = excluded.position,
          role       = excluded.role,
          updated_at = now()
    returning id, first_name, role, status
  `;

  /** Все участники теста работают над одним тендером. */
  if (project && user) {
    await sql`
      insert into project_members (project_id, user_id, role)
      values (${project.id}, ${user.id}, ${p.role === 'manager' ? 'lead' : 'member'})
      on conflict (project_id, user_id) do update set role = excluded.role
    `;
  }

  console.log(`  ${p.firstName.padEnd(8)} @${username.padEnd(18)} ${p.role.padEnd(9)} ${user!.status}`);
}

console.log(`\nЗаведено: ${TEAM.length}`);
console.log('Каждому нужно открыть бота и нажать «Начать» — доступ откроется сам.');

await sql.end();

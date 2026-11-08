# Настройка с нуля

Пошаговый чек-лист: от пустого места до работающего бота. Порядок важен —
каждый следующий шаг использует то, что получено на предыдущем.

---

## 1. Бот в Telegram — 2 минуты

1. Написать [@BotFather](https://t.me/BotFather) → `/newbot`
2. Имя (видят люди): `ОСТРО`
3. Username (обязан заканчиваться на `bot`): например `ostro_team_bot`
4. Скопировать токен вида `7123456789:AAH...` → в `.env` как `TELEGRAM_BOT_TOKEN`

Сразу же, пока в BotFather:

```
/setdescription  — Задачи, дедлайны и отчётность команды
/setabouttext    — Рабочий бот команды
/setcommands
```

Список команд для `/setcommands`:

```
start - Начать работу
id - Показать мой Telegram ID
help - Что я умею
```

**Свой Telegram ID** узнаётся у [@userinfobot](https://t.me/userinfobot) —
запиши его в `BOOTSTRAP_ADMIN_TELEGRAM_ID`, иначе после первого запуска
в системе не будет ни одного администратора.

---

## 2. Локальная база

Вариант с установленным Postgres:

```bash
psql -U postgres -c "CREATE USER ostro WITH PASSWORD 'ostro';"
psql -U postgres -c "CREATE DATABASE ostro OWNER ostro;"
```

Вариант без установки — бесплатный [Neon](https://neon.tech): создать проект,
скопировать строку подключения в `DATABASE_URL`. На время разработки этого
достаточно, и на диске ничего не занимает.

Дальше в обоих случаях:

```bash
pnpm db:generate    # SQL-миграции из schema.ts
pnpm db:migrate     # применить
```

`JWT_SECRET` генерируется так:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 3. Доступ к Google-таблице

Бот ходит в таблицу от имени **сервис-аккаунта** — отдельной технической
учётки, а не от твоего личного Google. Так доступ можно отозвать одним
движением, не трогая ничей аккаунт.

1. [console.cloud.google.com](https://console.cloud.google.com) → создать проект
   (название любое, например `ostro`)
2. **APIs & Services → Library** → найти **Google Sheets API** → Enable
3. **APIs & Services → Credentials** → Create credentials → **Service account**
   - имя: `ostro-bot`
   - роль можно не назначать: права выдаются на уровне самой таблицы
4. Открыть созданный аккаунт → вкладка **Keys** → Add key → Create new key →
   **JSON** → файл скачается
5. Из JSON взять два поля:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (целиком, вместе с `-----BEGIN...`,
     в двойных кавычках, переносы строк остаются как `\n`)
6. **Открыть рабочую таблицу → Настройки доступа → добавить `client_email`
   с правом «Редактор».** Без этого шага бот получит 403, даже если всё
   остальное настроено верно.
7. ID таблицы — из её адреса, между `/d/` и `/edit`:
   `docs.google.com/spreadsheets/d/`**`1a2B3c...`**`/edit` → `GOOGLE_SPREADSHEET_ID`

Проверка доступа:

```bash
pnpm --filter @ostro/api exec tsx -e "
  import { SheetsClient } from '@ostro/sheets';
  const c = new SheetsClient({
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  });
  console.log(await c.verifyAccess());
"
```

---

## 4. Мгновенные правки из таблицы

Опрос таблицы раз в несколько минут работает и без этого шага. Но чтобы
перенос дедлайна доезжал до бота за секунду, а не за пять минут, ставится
скрипт:

1. Таблица → **Расширения → Apps Script**
2. Вставить содержимое [`infra/apps-script/Code.gs`](../infra/apps-script/Code.gs)
3. Заполнить `API_URL` (публичный адрес) и `SECRET` (`SHEETS_WEBHOOK_SECRET` из `.env`)
4. Слева значок будильника → **Добавить триггер**:
   функция `onEditTrigger`, источник «Из таблицы», тип «При изменении»
5. Запустить вручную `testConnection` — в логах должно появиться «связь есть»

Простой `onEdit(e)` тут не подойдёт: у простых триггеров нет права
на исходящие запросы, и скрипт будет молча ничего не делать.

---

## 5. Сервер

Требования скромные: 2 vCPU, 4 ГБ RAM, 40 ГБ диска, Ubuntu 24.04.
Для команды до двадцати человек этого с запасом.

```bash
# на сервере
curl -fsSL https://get.docker.com | sh
git clone <твой-репозиторий> ostro && cd ostro
cp .env.example .env && nano .env      # заполнить, включая DOMAIN и POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec api node dist/migrate.js
```

**Домен.** Нужна A-запись, ведущая на IP сервера. Caddy получит сертификат
сам при первом запуске — отдельно ничего делать не надо, но 80-й и 443-й
порты должны быть открыты, иначе проверка Let's Encrypt не пройдёт.

**Webhook.** После того как домен заработал, в `.env` добавляется
`TELEGRAM_WEBHOOK_URL=https://твой-домен` и длинный случайный
`TELEGRAM_WEBHOOK_SECRET`. При следующем запуске API сам зарегистрирует
webhook в Telegram и выключит long polling.

**Mini App.** В BotFather: `/newapp` → выбрать бота → указать
`https://твой-домен` как адрес приложения.

---

## 6. Первые данные

Администратор появляется из `BOOTSTRAP_ADMIN_TELEGRAM_ID` при первом
запуске сидов:

```bash
pnpm db:seed
```

Дальше сотрудники заводятся администратором. Telegram ID знать
необязательно — достаточно `@username`, привязка произойдёт сама,
когда человек впервые нажмёт `/start`.

---

## Частые ошибки

| Симптом | Причина |
|---|---|
| Бот молчит на `/start` | Не запущен API, либо токен из другого бота |
| `403` от Google | Таблица не расшарена на `client_email` сервис-аккаунта |
| `Подпись initData не сошлась` | В `.env` токен одного бота, а Mini App открыт у другого |
| Белый экран Mini App в Telegram | Открыт по `http://`, нужен только `https://` |
| Apps Script ничего не шлёт | Поставлен простой `onEdit` вместо устанавливаемого триггера |
| Напоминания не приходят | Не запущен `worker` — он отдельный процесс |

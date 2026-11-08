/**
 * Google Apps Script для таблицы ОСТРО.
 *
 * Задача одна: как только человек правит строку в таблице, сообщить об этом
 * боту, не дожидаясь следующего опроса. Без этого правка «перенёс дедлайн»
 * доезжает до бота через несколько минут, и всё это время сотруднику
 * продолжают приходить напоминания по старому сроку.
 *
 * УСТАНОВКА
 * 1. Открой таблицу → Расширения → Apps Script.
 * 2. Вставь этот файл, замени содержимое Code.gs целиком.
 * 3. Заполни адрес API ниже, а секрет SHEETS_WEBHOOK_SECRET — в Script Properties.
 * 4. Триггеры (значок будильника слева) → Добавить триггер:
 *    функция onEditTrigger, событие «Из таблицы» → «При изменении».
 *    Обычный onEdit здесь не годится: простые триггеры не имеют права
 *    ходить в интернет.
 * 5. При первом запуске Google попросит разрешения — это нормально,
 *    скрипт запрашивает только доступ к этой таблице и к внешним запросам.
 */

const SETTINGS = {
  /** Адрес API без слэша на конце: https://ostro.example.com */
  API_URL: 'https://ЗАМЕНИ-НА-СВОЙ-ДОМЕН',

  /** Значение SHEETS_WEBHOOK_SECRET из .env приложения. Должно совпадать точно. */
  SECRET: PropertiesService.getScriptProperties().getProperty('SHEETS_WEBHOOK_SECRET') || '',

  /** Листы, за которыми следим. Правки на остальных игнорируются. */
  WATCHED_SHEETS: ['Задачи', 'КП', 'Статусы'],

  /** Первая строка с данными: выше лежат заголовки. */
  FIRST_DATA_ROW: 2,

  /** Сколько колонок отправлять. Должно совпадать с разбором на стороне бота. */
  COLUMN_COUNT: 11,
};

/**
 * Обработчик правки.
 *
 * Ошибки наружу не выбрасываем: если бот недоступен, человек в таблице
 * не должен видеть красное сообщение об ошибке — он просто работает дальше,
 * а расхождение подберёт следующий полный синк со стороны бота.
 */
function onEditTrigger(e) {
  try {
    if (!e || !e.range) return;

    const sheet = e.range.getSheet();
    const sheetName = sheet.getName();

    if (SETTINGS.WATCHED_SHEETS.indexOf(sheetName) === -1) return;

    const row = e.range.getRow();
    if (row < SETTINGS.FIRST_DATA_ROW) return;

    /** Отправляем всю строку целиком: бот разбирает её тем же кодом, что и при полном синке. */
    const values = sheet
      .getRange(row, 1, 1, SETTINGS.COLUMN_COUNT)
      .getDisplayValues()[0];

    notify({
      spreadsheetId: sheet.getParent().getId(),
      sheetName: sheetName,
      row: row,
      values: values,
      editedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('ОСТРО: не удалось обработать правку — ' + error);
  }
}

function notify(payload) {
  const response = UrlFetchApp.fetch(SETTINGS.API_URL + '/hooks/sheets', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Ostro-Secret': SETTINGS.SECRET },
    payload: JSON.stringify(payload),
    /** Иначе Apps Script считает любой не-200 фатальной ошибкой скрипта. */
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 202 && code !== 200) {
    console.error('ОСТРО: API ответил ' + code + ' — ' + response.getContentText());
  }
}

/**
 * Разовая проверка связи. Запусти вручную из редактора после настройки:
 * в логах должно появиться «связь есть».
 */
function testConnection() {
  const response = UrlFetchApp.fetch(SETTINGS.API_URL + '/health', {
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() === 200) {
    console.log('ОСТРО: связь есть — ' + response.getContentText());
  } else {
    console.error(
      'ОСТРО: API не отвечает (' + response.getResponseCode() + '). Проверь API_URL.',
    );
  }
}

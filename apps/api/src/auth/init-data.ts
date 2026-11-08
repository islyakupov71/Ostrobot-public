import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка подписи Telegram Mini App.
 *
 * Всё, что Mini App присылает в initData, приходит от клиента, а значит
 * может быть подделано. Единственное, что отличает настоящего пользователя
 * от кого угодно с curl, — HMAC-подпись, которую умеет поставить только
 * владелец токена бота. Пока эта функция не сказала «да», данным из initData
 * нельзя верить ни в чём, включая user.id.
 *
 * Алгоритм задан Telegram и повторён здесь буквально:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
};

export type InitData = {
  user?: TelegramUser;
  auth_date: number;
  query_id?: string;
  start_param?: string;
  chat_instance?: string;
};

export type ValidationResult =
  | { ok: true; data: InitData }
  | {
      ok: false;
      reason: 'missing_hash' | 'bad_signature' | 'expired' | 'malformed';
      /** Имена пришедших полей — только для диагностики, без значений. */
      fields?: string[];
    };

/**
 * Максимальный возраст подписи.
 *
 * Без этой проверки перехваченная один раз строка initData работала бы вечно.
 * Час — компромисс: Telegram обновляет initData при открытии приложения,
 * а долгие сессии всё равно живут на нашем собственном JWT.
 */
const MAX_AGE_SECONDS = 3600;

export function validateInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSeconds: number = MAX_AGE_SECONDS,
): ValidationResult {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initDataRaw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };

  /**
   * Строка проверки: все пары кроме hash, отсортированные по ключу
   * и соединённые переводом строки. Значения берутся уже раскодированными.
   *
   * Исключается ровно одно поле — hash. Соблазн выкинуть заодно signature
   * велик: оно появилось в initData позже остальных и участвует совсем
   * в другой проверке, предназначенной для сторонних сервисов. Но в строку
   * для HMAC оно входит наравне со всеми, и без него подпись не сходится
   * никогда: вход перестаёт работать сразу у всех, а выглядит это как
   * «указан не тот токен бота».
   */
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  /**
   * Секретный ключ — это HMAC от токена бота с фиксированной строкой-ключом
   * «WebAppData». Порядок аргументов здесь обратный интуитивному:
   * ключом выступает константа, данными — токен. Перепутать местами легко,
   * и тогда подпись не сойдётся никогда.
   */
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  /**
   * Сравнение за постоянное время: обычное === выходит на первом
   * несовпавшем байте и по времени ответа выдаёт, сколько байт угадано.
   */
  const expected = Buffer.from(computed, 'hex');
  const received = Buffer.from(hash, 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    /**
     * В журнал уходит только перечень имён полей: по нему видно, не появилось
     * ли в initData чего-то нового, а персональные данные никуда не попадают.
     */
    return { ok: false, reason: 'bad_signature', fields: [...params.keys()].sort() };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'malformed' };

  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'expired' };

  let user: TelegramUser | undefined;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramUser;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }

  return {
    ok: true,
    data: {
      user,
      auth_date: authDate,
      query_id: params.get('query_id') ?? undefined,
      start_param: params.get('start_param') ?? undefined,
      chat_instance: params.get('chat_instance') ?? undefined,
    },
  };
}

/** Человекочитаемая причина отказа — уходит в лог, но не пользователю. */
export const VALIDATION_MESSAGES: Record<
  Exclude<ValidationResult, { ok: true }>['reason'],
  string
> = {
  missing_hash: 'В initData нет подписи',
  bad_signature: 'Подпись initData не сошлась — данные подделаны или токен бота другой',
  expired: 'Подпись initData просрочена, приложение нужно переоткрыть',
  malformed: 'initData не разбирается',
};

import { TZDate } from '@date-fns/tz';

/**
 * Тихие часы.
 *
 * Бот, который будит человека в три ночи напоминанием о задаче на послезавтра,
 * получает мьют — и вместе с мьютом перестают доходить действительно срочные
 * сообщения. Поэтому рутинные напоминания копятся до утра, а сквозь тишину
 * проходит только то, что помечено respectQuietHours: false.
 */

export type QuietHours = {
  /** Локальное время начала тишины, HH:mm. */
  start: string;
  /** Локальное время конца тишины, HH:mm. */
  end: string;
  /** Часовой пояс получателя — тишина считается по его времени, не по серверному. */
  timezone: string;
};

function parseHm(value: string): { hours: number; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Попадает ли момент в тихие часы получателя.
 * Интервал может пересекать полночь (22:00–08:00) — это обычный случай.
 */
export function isQuietTime(at: Date, quiet: QuietHours): boolean {
  const start = parseHm(quiet.start);
  const end = parseHm(quiet.end);
  if (!start || !end) return false;

  const local = new TZDate(at, quiet.timezone);
  const minutes = local.getHours() * 60 + local.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes === endMinutes) return false;

  return startMinutes < endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : /** Интервал через полночь: тишина либо после начала, либо до конца. */
      minutes >= startMinutes || minutes < endMinutes;
}

/**
 * Ближайший момент, когда сообщение можно доставить.
 *
 * Если время не тихое — возвращаем его как есть, накопления не происходит.
 * Если тихое — сдвигаем ровно на момент окончания тишины в поясе получателя.
 */
export function nextDeliverableTime(at: Date, quiet: QuietHours): Date {
  if (!isQuietTime(at, quiet)) return at;

  const end = parseHm(quiet.end);
  if (!end) return at;

  const local = new TZDate(at, quiet.timezone);
  const target = new TZDate(at, quiet.timezone);
  target.setHours(end.hours, end.minutes, 0, 0);

  /**
   * Если конец тишины по локальному времени уже позади (сообщение пришло
   * в 23:30 при тишине 22:00–08:00), утро наступит завтра.
   */
  if (target.getTime() <= local.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return new Date(target.getTime());
}

/** Настройки по умолчанию, когда у пользователя нет персональных. */
export const DEFAULT_QUIET_HOURS: Omit<QuietHours, 'timezone'> = {
  start: '22:00',
  end: '08:00',
};

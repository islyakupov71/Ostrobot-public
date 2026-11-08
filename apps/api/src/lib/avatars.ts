import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import type { Api } from 'grammy';

/**
 * Аватарки сотрудников.
 *
 * Экран постановки задачи — это сетка лиц: руководитель выбирает человека
 * взглядом, а не читает список имён. Поэтому фотографии нужны настоящие.
 *
 * Telegram не отдаёт ссылку на аватар напрямую: сначала getUserProfilePhotos
 * даёт идентификатор файла, потом getFile — временный путь, живущий около
 * часа. Ссылку с таким сроком жизни нельзя ни закэшировать, ни положить
 * в интерфейс, поэтому файл скачивается один раз и лежит у нас.
 *
 * Отдаёт его веб-сервер напрямую из папки, минуя приложение: картинка
 * не должна занимать обработчик запроса.
 */

const AVATAR_DIR = process.env.AVATAR_DIR ?? '/opt/ostro/avatars';

/** Обновляем не чаще раза в неделю: люди меняют аватарки редко. */
const REFRESH_AFTER_MS = 7 * 24 * 3600_000;

export function avatarPath(userId: string): string {
  return join(AVATAR_DIR, `${userId}.jpg`);
}

export function avatarUrl(userId: string): string {
  return `/avatars/${userId}.jpg`;
}

async function isFresh(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs < REFRESH_AFTER_MS;
  } catch {
    return false;
  }
}

export async function hasAvatar(userId: string): Promise<boolean> {
  try {
    await stat(avatarPath(userId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Скачивает аватарку, если её ещё нет или она устарела.
 *
 * Тихо ничего не делает, когда фотографии нет или профиль закрыт настройками
 * приватности — это обычное дело, а не сбой. Интерфейс в таком случае
 * покажет инициалы.
 */
export async function fetchAvatar(
  api: Api,
  telegramId: string | number,
  userId: string,
  botToken: string,
): Promise<boolean> {
  const path = avatarPath(userId);
  if (await isFresh(path)) return true;

  try {
    const photos = await api.getUserProfilePhotos(Number(telegramId), { limit: 1 });
    const sizes = photos.photos[0];
    if (!sizes || sizes.length === 0) return false;

    /**
     * Берём предпоследний размер, а не самый большой: на экране аватар
     * занимает шестьдесят пикселей, а оригинал весит под мегабайт.
     */
    const chosen = sizes.length > 1 ? sizes[sizes.length - 2]! : sizes[0]!;

    const file = await api.getFile(chosen.file_id);
    if (!file.file_path) return false;

    const response = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
    );
    if (!response.ok || !response.body) return false;

    await mkdir(AVATAR_DIR, { recursive: true });

    /**
     * Пишем во временный файл и переименовываем: иначе при обрыве загрузки
     * на месте аватарки останется битый кусок, и браузер закэширует его.
     */
    const tmp = `${path}.tmp`;
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp));

    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);

    return true;
  } catch {
    return false;
  }
}

/** Убираем картинку, когда сотрудника отключают. */
export async function removeAvatar(userId: string): Promise<void> {
  try {
    await unlink(avatarPath(userId));
  } catch {
    /* файла не было — это не ошибка */
  }
}

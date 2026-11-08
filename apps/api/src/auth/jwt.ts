import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import type { UserRole } from '@ostro/shared';

/**
 * Сессии Mini App.
 *
 * initData от Telegram живёт около часа и проверяется тяжёлым HMAC на каждом
 * запросе. Поэтому проверяем её один раз при входе, а дальше выдаём собственный
 * короткоживущий access-токен и долгоживущий refresh, хеш которого лежит в базе,
 * — так сессию можно отозвать, если сотрудник уволился.
 */

export type SessionClaims = {
  sub: string;
  role: UserRole;
  tg: string;
};

export function createJwtTools(secret: string, accessTtl: string, refreshTtl: string) {
  const key = new TextEncoder().encode(secret);

  return {
    async signAccess(claims: SessionClaims): Promise<string> {
      return new SignJWT({ role: claims.role, tg: claims.tg })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuedAt()
        .setIssuer('ostro')
        .setExpirationTime(accessTtl)
        .sign(key);
    },

    async verifyAccess(token: string): Promise<SessionClaims | null> {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: 'ostro' });
        if (!payload.sub) return null;
        return { sub: payload.sub, role: payload.role as UserRole, tg: String(payload.tg ?? '') };
      } catch {
        return null;
      }
    },

    /** Refresh — просто случайная строка: смысла подписывать её нет, она проверяется по базе. */
    issueRefresh(): { token: string; hash: string; expiresAt: Date } {
      const token = randomBytes(32).toString('base64url');
      const days = Number(refreshTtl.replace(/\D/g, '')) || 30;
      return {
        token,
        hash: hashRefresh(token),
        expiresAt: new Date(Date.now() + days * 86_400_000),
      };
    },
  };
}

export function hashRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

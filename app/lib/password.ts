import bcrypt from "bcryptjs";

/**
 * Hashing de senha com bcrypt + verificação com rehash transparente.
 *
 * Contexto: o banco tinha senhas em TEXTO PLANO. Migrar para hash sem reset
 * forçado exige um caminho de compatibilidade: no login, se o valor armazenado
 * ainda é texto plano e bate com a senha enviada, regravamos como hash. Assim
 * a base migra sozinha, login a login, sem nenhum usuário ser deslogado.
 *
 * O REPOSITÓRIO é o único ponto que transforma senha em hash (create/update);
 * a camada de auth apenas VERIFICA e sinaliza necessidade de rehash.
 */

const BCRYPT_COST = 12;

/** Um valor já é um hash bcrypt? (prefixos $2a$ / $2b$ / $2y$) */
export function isHashed(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$/.test(value);
}

/** Gera o hash bcrypt de uma senha em texto plano. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Verifica uma senha contra o valor armazenado (hash OU texto plano legado).
 * Retorna `valid` e `needsRehash` (true quando o valor legado em texto plano
 * bateu — o chamador deve regravar como hash).
 */
export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (!stored) return { valid: false, needsRehash: false };

  if (isHashed(stored)) {
    const valid = await bcrypt.compare(plain, stored);
    return { valid, needsRehash: false };
  }

  // Legado: senha armazenada em texto plano. Comparação direta; se bater,
  // sinaliza para regravar como hash (migração transparente).
  const valid = plain === stored;
  return { valid, needsRehash: valid };
}

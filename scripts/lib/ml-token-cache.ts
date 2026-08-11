/**
 * Cache de access token do Mercado Livre para scripts de longa duração.
 *
 * POR QUE EXISTE (incidente de 25/07/2026): o backfill de compatibilidade
 * cacheava o token assim:
 *
 *     const tokenCache = new Map<string, string>();
 *     const cached = tokenCache.get(account.id);
 *     if (cached) return cached;            // <- sem validade nenhuma
 *
 * A verificação de `expiresAt` só rodava quando o cache estava VAZIO, ou seja
 * uma única vez no processo inteiro. Como o token do ML vive ~6h e uma corrida
 * completa (5.361 anúncios, cada um com resolução de marca/modelo/ano + PUT +
 * read-back) passa disso com folga, o token morria no meio: **887 anúncios
 * gravados e 4.497 falhas seguidas com 401 "invalid access token"**.
 *
 * O refresh token também é guardado porque o ML o **rotaciona** a cada
 * renovação. O código antigo relia `account.refreshToken` do snapshot inicial,
 * então uma segunda renovação no mesmo processo usaria um refresh token já
 * consumido e falharia — bug latente que nunca chegou a disparar porque a
 * primeira renovação já era a única.
 *
 * As dependências entram por parâmetro (refresh, persist, relógio) para este
 * módulo ser testável sem rede e sem banco. O script de backfill não pode ser
 * importado por um teste: ele chama `main()` no topo do módulo.
 */

export interface MLTokenSnapshot {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface MLTokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  /** Segundos de validade, como o ML devolve. */
  expiresIn: number;
}

interface CachedMLToken {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

/**
 * Margem antes do vencimento real. Renovar só no instante exato deixaria
 * requisições já em voo com um token morto — e cada anúncio dispara várias.
 */
export const TOKEN_SKEW_MS = 5 * 60_000;

/** Decisão pura: este token ainda serve neste instante? */
export function tokenAindaVale(
  expiresAtMs: number,
  agoraMs: number,
  skewMs: number = TOKEN_SKEW_MS,
): boolean {
  return Number.isFinite(expiresAtMs) && expiresAtMs > agoraMs + skewMs;
}

export interface CacheDeTokenDeps {
  /** Troca o refresh token por um par novo. */
  refresh: (
    accountId: string,
    refreshToken: string,
  ) => Promise<MLTokenRefreshResult>;
  /** Grava o par novo no banco. */
  persist: (
    accountId: string,
    dados: { accessToken: string; refreshToken: string; expiresAt: Date },
  ) => Promise<void>;
  /** Injetável para teste. */
  agora?: () => number;
  skewMs?: number;
  /** Chamado a cada renovação — o script usa para logar. */
  onRenew?: (accountId: string, expiresInSec: number) => void;
}

/**
 * Devolve `getValidToken(account)`, que SEMPRE confere a validade antes de
 * reusar o token — é essa checagem por chamada que faltava.
 */
export function criarCacheDeToken(
  deps: CacheDeTokenDeps,
): (account: MLTokenSnapshot) => Promise<string> {
  const cache = new Map<string, CachedMLToken>();
  const agora = deps.agora ?? (() => Date.now());
  const skewMs = deps.skewMs ?? TOKEN_SKEW_MS;
  /** Renovações em voo por conta, para duas chamadas não renovarem juntas. */
  const emVoo = new Map<string, Promise<string>>();

  return async function getValidToken(
    account: MLTokenSnapshot,
  ): Promise<string> {
    const cached = cache.get(account.id);
    if (cached && tokenAindaVale(cached.expiresAtMs, agora(), skewMs)) {
      return cached.accessToken;
    }

    // Primeira vez para esta conta: o token do banco pode servir.
    if (!cached) {
      const doBanco = new Date(account.expiresAt).getTime();
      if (tokenAindaVale(doBanco, agora(), skewMs)) {
        cache.set(account.id, {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAtMs: doBanco,
        });
        return account.accessToken;
      }
    }

    const jaRenovando = emVoo.get(account.id);
    if (jaRenovando) return jaRenovando;

    // O refresh token do CACHE tem precedência: o do snapshot pode já ter sido
    // rotacionado por uma renovação anterior deste mesmo processo.
    const refreshToken = cached?.refreshToken ?? account.refreshToken;

    const renovacao = (async (): Promise<string> => {
      const novo = await deps.refresh(account.id, refreshToken);
      const expiresAtMs = agora() + novo.expiresIn * 1000;
      await deps.persist(account.id, {
        accessToken: novo.accessToken,
        refreshToken: novo.refreshToken,
        expiresAt: new Date(expiresAtMs),
      });
      cache.set(account.id, {
        accessToken: novo.accessToken,
        refreshToken: novo.refreshToken,
        expiresAtMs,
      });
      deps.onRenew?.(account.id, novo.expiresIn);
      return novo.accessToken;
    })();

    emVoo.set(account.id, renovacao);
    try {
      return await renovacao;
    } finally {
      emVoo.delete(account.id);
    }
  };
}

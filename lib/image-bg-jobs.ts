/**
 * Cliente do polling do recorte assíncrono (PR 4).
 *
 * ⚠️ MESMAS TRÊS INVARIANTES do monkey-patch de auth descritas no topo de
 * `lib/upload-image.ts`: (1) `fetch` global resolvido NA CHAMADA; (2) URL por
 * concatenação com `getApiBaseUrl()`; (3) NUNCA setar o header authorization.
 */

import { getApiBaseUrl } from "./api";

export interface ImageBgJobStatus {
  id: string;
  /** PENDING | PROCESSING | COMPLETED | FAILED */
  status: string;
  attempts: number;
  webpUrl: string;
  resultUrl?: string;
  error?: string;
}

export const IMAGE_BG_TERMINAL_STATUSES = ["COMPLETED", "FAILED"];

export function isImageBgJobTerminal(status: string): boolean {
  return IMAGE_BG_TERMINAL_STATUSES.includes(status);
}

/**
 * Teto de cada chamada do polling.
 *
 * ⚠️ SEM ISTO O POLLING MORRE CALADO: `use-image-bg-jobs` só agenda o próximo
 * tick DEPOIS que o `await` retorna, então um socket pendurado (proxy, rede
 * oscilando, sleep/resume do notebook) congela a cadeia inteira PARA SEMPRE e o
 * usuário fica com o spinner eterno. 15s é folgado: o p99 medido em produção
 * deste endpoint é 130ms.
 */
export const IMAGE_BG_FETCH_TIMEOUT_MS = 15_000;

/** `fetch` nu (invariantes 1-3 do topo) com deadline via AbortController. */
async function fetchWithDeadline(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    IMAGE_BG_FETCH_TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Busca o status de um lote de jobs (máx. 50). Lança em erro HTTP/rede. */
export async function fetchImageBgJobs(
  ids: string[],
): Promise<ImageBgJobStatus[]> {
  if (ids.length === 0) return [];
  const qs = encodeURIComponent(ids.slice(0, 50).join(","));
  const response = await fetchWithDeadline(
    `${getApiBaseUrl()}/upload/image/jobs?ids=${qs}`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error(`polling de jobs falhou: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { jobs?: ImageBgJobStatus[] };
  return body.jobs ?? [];
}

/**
 * Texto do overlay do recorte, por faixa de tempo decorrido.
 *
 * A espera REAL medida em produção é p50 2min / p90 6,8min (o sidecar é 1
 * worker de CPU a ~10s por imagem e o lote inteiro chega de uma vez). Um
 * spinner repetindo a MESMA frase por 6 minutos é lido como travamento — daí
 * mostrar o tempo decorrido.
 *
 * E "pode salvar e fechar" é literalmente verdade: o swap WebP→PNG acontece no
 * SERVIDOR (`swapImageUrlReferences` + varreduras extras em +2min e +8min), ou
 * seja, o recorte entra no produto mesmo com a tela fechada.
 *
 * O texto inline é curto de propósito (célula estreita, com `truncate`); a
 * versão completa vai no `title`.
 */
export function bgJobProgressLabel(elapsedMs: number): {
  short: string;
  full: string;
} {
  const min = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (min < 1) {
    return {
      short: "Recortando fundo…",
      full: "Recortando o fundo desta imagem…",
    };
  }
  if (min < 5) {
    return {
      short: `Na fila · ${min} min — pode salvar`,
      full: `Na fila do recorte há ${min} min — pode salvar normalmente, a imagem é trocada sozinha quando ficar pronta.`,
    };
  }
  return {
    short: `Na fila · ${min} min — pode salvar e fechar`,
    full: `Na fila do recorte há ${min} min. Pode salvar e fechar: o recorte é aplicado no servidor e entra no produto sozinho, mesmo com esta tela fechada.`,
  };
}

/** Re-enfileira um job FAILED. Devolve true se o servidor aceitou. */
export async function retryImageBgJob(id: string): Promise<boolean> {
  const response = await fetchWithDeadline(
    `${getApiBaseUrl()}/upload/image/jobs/${encodeURIComponent(id)}/retry`,
    { method: "POST" },
  );
  return response.ok;
}

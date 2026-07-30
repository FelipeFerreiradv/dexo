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

/** Busca o status de um lote de jobs (máx. 50). Lança em erro HTTP/rede. */
export async function fetchImageBgJobs(
  ids: string[],
): Promise<ImageBgJobStatus[]> {
  if (ids.length === 0) return [];
  const qs = encodeURIComponent(ids.slice(0, 50).join(","));
  const response = await fetch(
    `${getApiBaseUrl()}/upload/image/jobs?ids=${qs}`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error(`polling de jobs falhou: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { jobs?: ImageBgJobStatus[] };
  return body.jobs ?? [];
}

/** Re-enfileira um job FAILED. Devolve true se o servidor aceitou. */
export async function retryImageBgJob(id: string): Promise<boolean> {
  const response = await fetch(
    `${getApiBaseUrl()}/upload/image/jobs/${encodeURIComponent(id)}/retry`,
    { method: "POST" },
  );
  return response.ok;
}

import { basename, join, sep } from "path";

/**
 * Política de cache dos arquivos estáticos servidos por `@fastify/static`.
 *
 * Extraído de `app/api/api.ts` para ser testável: importar o `api.ts` roda
 * `loadEnvOrExit()` e instancia o servidor inteiro.
 */

/** Um ano — o teto convencional de `max-age`. */
export const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;
export const IMMUTABLE_CACHE_CONTROL = `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`;

/**
 * Exatamente o que o `@fastify/static` já respondia antes desta mudança
 * (`maxAge` default 0). Repetimos o valor à mão porque a registração passa a
 * usar `cacheControl: false` — ver `cacheControlFor`.
 */
export const REVALIDATE_CACHE_CONTROL = "public, max-age=0";

/**
 * Header de cache para um arquivo estático.
 *
 * ⚠️ ARMADILHA DA BIBLIOTECA (custou um teste de integração para achar):
 * no `@fastify/static` v9 o handler faz, nesta ordem,
 * `setHeaders(reply.raw, ...)` e DEPOIS `reply.headers(headers)` — os headers
 * calculados pelo `send` SOBRESCREVEM o que o `setHeaders` acabou de pôr. Ou
 * seja, `setHeaders` sozinho NÃO consegue mudar o `Cache-Control`: o valor
 * voltava para `public, max-age=0` silenciosamente.
 *
 * Por isso a registração usa `cacheControl: false` (o `send` para de calcular
 * o header) e nós devolvemos o valor dos DOIS casos aqui — o imutável para os
 * uploads e o de sempre para todo o resto, preservando o comportamento
 * anterior byte a byte.
 */
export function cacheControlFor(filePath: string, rootDir?: string): string {
  return isImmutableUploadPath(filePath, rootDir)
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATE_CACHE_CONTROL;
}

/**
 * Só arquivos nomeados por UUID dentro de `public/uploads` — nada mais.
 *
 * POR QUE ESTE ESCOPO É ESTREITO DE PROPÓSITO
 * -------------------------------------------
 * O `root` do static é `public/` INTEIRO, e ali também moram `logo.jpg`,
 * `icon-192.png`, `api-docs/` e `marketplaces/` — arquivos que SÃO substituídos
 * pelo MESMO nome a cada deploy. Marcá-los `immutable` deixaria um logo trocado
 * preso no navegador do cliente por um ano, sem forma de invalidar.
 *
 * Já `/uploads/<uuid>.webp|.png|.orig.<ext>` é conteúdo imutável de verdade:
 * todos os pontos de escrita do repo derivam de um `randomUUID()` novo
 * (`upload.routes.ts` e `image-bg-worker.service.ts`), então um nome nunca
 * recebe conteúdo diferente. O swap do recorte troca a URL (`.webp` → `.png`),
 * não o conteúdo de uma URL existente.
 */
export function isImmutableUploadPath(
  filePath: string,
  rootDir: string = process.cwd(),
): boolean {
  const uploadsPrefix = join(rootDir, "public", "uploads") + sep;
  if (!filePath.startsWith(uploadsPrefix)) return false;
  // O nome tem que COMEÇAR com o uuid e ter sufixo (`.webp`, `.orig.jpg`...).
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i.test(
    basename(filePath),
  );
}

/**
 * Carrega a imagem de identidade do tenant (`User.avatarUrl`) em bytes prontos
 * para embutir num PDF.
 *
 * DUPLICAÇÃO DELIBERADA de `NfeEmissionUseCase.loadDanfeAvatar`. Extrair aquele
 * método para cá exigiria editar `nfe-emission.usecase.ts` — arquivo de lógica
 * de negócio e persistência da NF-e, cujo call-site vive DENTRO do bloco que
 * grava `danfePdfPath`. Trocar risco no caminho fiscal por ~40 linhas
 * economizadas é um mau negócio.
 *
 * ─── EGRESS ────────────────────────────────────────────────────────────────
 * Este módulo roda por DOWNLOAD de cupom, não uma vez por processo. Três
 * cuidados, todos medidos, seguindo as convenções da branch de Segurança e
 * Otimização:
 *
 *  1. LEITURA LOCAL. `avatarUrl` é produzido pelo próprio upload da plataforma
 *     (`upload.routes.ts` → `${APP_BACKEND_URL}/uploads/<arquivo>`) e o Fastify
 *     serve `/uploads` do disco (`fastify-static` sobre `public/`). Buscar isso
 *     por HTTP é o processo abrindo conexão para si mesmo — passando por nginx,
 *     rate-limit e log — para ler um arquivo que está no mesmo filesystem.
 *     Lemos do disco e só caímos no `fetch` para URL externa ou arquivo ausente.
 *     Mesmo atalho já em produção em `shopee-api.service.ts` (OPT-8).
 *
 *  2. REDIMENSIONAMENTO. A imagem é desenhada num círculo de no máximo 40pt.
 *     Embutir o original (o upload aceita até 1600px) colocava 176 KB de PNG
 *     num cupom de 4,8 KB — medido. Reduzir para 120px (216 DPI no tamanho
 *     desenhado, acima da qualidade de impressão) leva o embed a ~5 KB.
 *
 *  3. CACHE. A logo não muda entre requisições. Cache de módulo com TTL,
 *     chaveado por `userId`, guardando TAMBÉM o resultado nulo (cache negativo)
 *     — é o mesmo papel do `logoBytesCache` que o cupom tinha antes de passar a
 *     usar a identidade do cliente. Sem ele, um tenant com `avatarUrl` apontando
 *     para arquivo removido paga um 404 por download, para sempre.
 *
 * Best-effort do começo ao fim: qualquer falha devolve `null` e o documento cai
 * nas iniciais da razão social. Nunca lança.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { normalizeAvatarBytes } from "./danfe-avatar";
import type { DanfeAvatar } from "./danfe-v2-renderer";

/** Timeout do fetch — cobre headers E corpo (ver nota em `baixarPorHttp`). */
const FETCH_TIMEOUT_MS = 3000;

/**
 * Lado do quadrado em que a imagem é embutida.
 *
 * O maior consumo é o círculo de r=20 do cupom (40pt). 120px nesse tamanho dá
 * 216 DPI — acima do que qualquer impressora resolve num elemento de 1,4 cm.
 */
const AVATAR_PX = 120;

/** Quanto tempo a imagem resolvida vale antes de ser relida. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Teto de entradas — uma por tenant ativo; cada uma tem ~5 KB. */
const CACHE_MAX = 200;

interface Entrada {
  at: number;
  valor: DanfeAvatar | null;
}

const cache = new Map<string, Entrada>();

/** Chaves de falha já logadas, para não repetir o mesmo aviso por requisição. */
const jaAvisado = new Set<string>();

function avisarUmaVez(chave: string, msg: string): void {
  if (jaAvisado.has(chave)) return;
  jaAvisado.add(chave);
  // Teto simples: o conjunto não pode crescer indefinidamente num processo longo.
  if (jaAvisado.size > CACHE_MAX * 2) jaAvisado.clear();
  console.warn(msg);
}

function guardar(userId: string, valor: DanfeAvatar | null): DanfeAvatar | null {
  if (cache.size >= CACHE_MAX) {
    // Descarta a entrada mais antiga (Map preserva ordem de inserção).
    const primeira = cache.keys().next();
    if (!primeira.done) cache.delete(primeira.value);
  }
  cache.set(userId, { at: Date.now(), valor });
  return valor;
}

interface AvatarLookup {
  user: {
    findUnique: (args: {
      where: { id: string };
      select: { avatarUrl: true };
    }) => Promise<{ avatarUrl: string | null } | null>;
  };
}

/**
 * Reduz a imagem ao tamanho em que ela é desenhada e devolve PNG.
 *
 * Aceita qualquer formato de entrada (o `sharp` decodifica WebP/AVIF/GIF além
 * de PNG/JPG). Falhou ⇒ `null`, e o chamador cai em `normalizeAvatarBytes`,
 * que é exatamente o comportamento anterior.
 */
async function reduzir(bytes: Uint8Array): Promise<DanfeAvatar | null> {
  try {
    const mod = await import("sharp");
    const sharp = (mod as unknown as { default?: unknown }).default ?? mod;
    const png = await (sharp as (b: Buffer) => {
      resize: (
        w: number,
        h: number,
        o: { fit: "cover"; withoutEnlargement: boolean },
      ) => { png: (o: { compressionLevel: number }) => { toBuffer: () => Promise<Buffer> } };
    })(Buffer.from(bytes))
      .resize(AVATAR_PX, AVATAR_PX, { fit: "cover", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { bytes: new Uint8Array(png), format: "png" };
  } catch {
    return null;
  }
}

/** Caminho no disco para uma URL servida pelo próprio `/uploads`. */
function caminhoLocal(raw: string): string | null {
  const base = (process.env.APP_BACKEND_URL ?? "").replace(/\/+$/, "");
  let rota: string | null = null;
  if (raw.startsWith("/uploads/")) rota = raw;
  else if (base && raw.startsWith(`${base}/uploads/`)) rota = raw.slice(base.length);
  if (!rota) return null;

  // `path.basename` sobre o pathname da URL descarta querystring e qualquer
  // tentativa de subir diretório — o arquivo só pode sair de public/uploads.
  const nome = path.basename(rota.split("?")[0]);
  if (!nome || nome === "." || nome === "..") return null;
  return path.join(process.cwd(), "public", "uploads", nome);
}

async function baixarPorHttp(url: string, logTag: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  // O timer só é cancelado DEPOIS de ler o corpo: um servidor que entrega os
  // headers e trava o body penduraria o download do cupom indefinidamente
  // (o Fastify deste projeto não define requestTimeout).
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      avisarUmaVez(`http:${url}`, `${logTag} fetch falhou (HTTP ${res.status}) url=${url}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function loadTenantAvatar(
  db: AvatarLookup,
  userId: string,
  logTag = "[Cupom avatar]",
): Promise<DanfeAvatar | null> {
  const emCache = cache.get(userId);
  if (emCache && Date.now() - emCache.at < CACHE_TTL_MS) return emCache.valor;

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });
    const raw = user?.avatarUrl ?? null;
    if (!raw) return guardar(userId, null);

    // ── 1. Bytes: disco quando a imagem é nossa, HTTP só para URL externa ──
    let bytes: Uint8Array | null = null;
    const local = caminhoLocal(raw);
    if (local) {
      try {
        bytes = new Uint8Array(await fs.readFile(local));
      } catch {
        bytes = null; // arquivo removido — cai no HTTP abaixo
      }
    }
    if (!bytes) {
      const base =
        process.env.APP_BACKEND_URL ??
        process.env.NEXT_PUBLIC_API_URL ??
        "http://localhost:3333";
      const url = raw.startsWith("http")
        ? raw
        : `${base.replace(/\/+$/, "")}${raw.startsWith("/") ? "" : "/"}${raw}`;
      bytes = await baixarPorHttp(url, logTag);
      if (!bytes) return guardar(userId, null);
    }

    // ── 2. Reduz ao tamanho desenhado; fallback = comportamento anterior ──
    const avatar = (await reduzir(bytes)) ?? (await normalizeAvatarBytes(bytes));
    if (!avatar) {
      avisarUmaVez(`embed:${raw}`, `${logTag} imagem não embutível url=${raw}`);
    }
    return guardar(userId, avatar);
  } catch (e) {
    avisarUmaVez(
      `erro:${userId}`,
      `${logTag} erro ao carregar: ${e instanceof Error ? e.message : String(e)}`,
    );
    return guardar(userId, null);
  }
}

/** Limpa o cache. Existe para os testes — não é usado em runtime. */
export function __clearAvatarCache(): void {
  cache.clear();
  jaAvisado.clear();
}

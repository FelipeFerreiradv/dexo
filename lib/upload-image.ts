/**
 * Cliente compartilhado do `POST /upload/image`.
 *
 * Extraído de `components/ui/multi-image-upload.tsx` e
 * `components/ui/image-upload.tsx`, que faziam o mesmo `fetch` duplicado — sem
 * timeout, e traduzindo qualquer falha para uma mensagem genérica.
 *
 * ⚠️ TRÊS INVARIANTES QUE NÃO PODEM SER QUEBRADAS
 * ------------------------------------------------
 * A autenticação desta chamada NÃO vem daqui: `components/api-auth-bridge.tsx`
 * instala um monkey-patch em `window.fetch` que injeta o `Authorization: Bearer`
 * quando a URL começa com `getApiBaseUrl()`. Portanto:
 *
 *  1. `fetch` precisa ser resolvido NO MOMENTO DA CHAMADA (identificador global
 *     nu). Capturar em escopo de módulo (`const f = globalThis.fetch`) pega a
 *     referência ORIGINAL se este módulo for avaliado antes do bridge — e a
 *     ordem dos chunks do Next não garante nada. Resultado: 401 silencioso.
 *  2. A URL precisa ser montada por concatenação com `getApiBaseUrl()`. O patch
 *     casa por `startsWith`; normalizar via `new URL()` ou usar caminho relativo
 *     quebra o casamento.
 *  3. NUNCA setar o header `authorization` aqui — o bridge PULA a injeção se o
 *     header já existir.
 *
 * `signal` é seguro: o bridge faz spread do `init` ao re-despachar.
 */

import { getApiBaseUrl } from "@/lib/api";

/** Limite aceito pelo backend (`MAX_BYTES` em `app/routes/upload.routes.ts`). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Base do deadline do cliente: orçamento do servidor (`UPLOAD_HANDLER_BUDGET_MS`,
 * 45s) + o que a ponte de auth pode segurar esperando o token (até 8s em
 * `components/api-auth-bridge.tsx`) + folga.
 */
export const UPLOAD_TIMEOUT_BASE_MS = 75_000;

/**
 * Vazão de subida pessimista assumida por arquivo, em bytes/ms (~128 KB/s).
 * Calibrada para 4G ruim de pátio com DOIS uploads dividindo o link
 * (`UPLOAD_CONCURRENCY = 2`), ou seja ~256 KB/s agregados.
 */
export const UPLOAD_ASSUMED_UPLINK_BYTES_PER_MS = 128;

/**
 * Deadline do cliente. É REDE DE SEGURANÇA, não o gatilho normal.
 *
 * ⚠️ O relógio do `AbortController` começa ANTES do `fetch`, então ele cobre
 * também a TRANSFERÊNCIA do corpo — que o orçamento do servidor não cobre (o
 * nginx bufferiza o corpo antes de repassar, então os 45s do handler só começam
 * depois). Um valor fixo transformaria upload lento-porém-bem-sucedido em falha
 * dura: como `imageUrl` é obrigatório no formulário de produto
 * (`create-product-dialog.tsx:122`), isso BLOQUEARIA a criação do produto — e o
 * arquivo já estaria gravado no servidor, sem como recuperá-lo.
 *
 * Por isso o deadline escala com o tamanho do arquivo: assim ele nunca preempta
 * a degradação graceful de 200 que o backend garante, e só dispara quando a
 * conexão realmente morreu.
 */
export function computeUploadTimeoutMs(fileSizeBytes: number): number {
  const transferAllowanceMs = Math.ceil(
    Math.max(0, fileSizeBytes) / UPLOAD_ASSUMED_UPLINK_BYTES_PER_MS,
  );
  return UPLOAD_TIMEOUT_BASE_MS + transferAllowanceMs;
}

export type UploadErrorKind =
  "timeout" | "network" | "server" | "canceled" | "unknown";

export class UploadImageError extends Error {
  readonly kind: UploadErrorKind;
  readonly status?: number;

  constructor(message: string, kind: UploadErrorKind, status?: number) {
    super(message);
    this.name = "UploadImageError";
    this.kind = kind;
    this.status = status;
  }
}

export interface UploadImageOptions {
  removeBackground: boolean;
  addShadow: boolean;
  /**
   * Opt-in do RECORTE ASSÍNCRONO (PR 4): o servidor responde na hora com a
   * WebP otimizada + `bgJob` e o recorte roda em background (só acontece se
   * UPLOAD_ASYNC_REMBG também estiver ligado no servidor — duplo opt-in).
   * Sem efeito quando removeBackground=false.
   */
  asyncBg?: boolean;
  /** Cancelamento externo (ex.: fechar o modal). */
  signal?: AbortSignal;
  /** Override do deadline — usado nos testes. */
  timeoutMs?: number;
}

export interface UploadBgJobRef {
  jobId: string;
  status: string;
}

export interface UploadImageResult {
  url: string;
  warning?: string;
  /** Presente quando o recorte ficou para o background (caminho assíncrono):
   *  a `url` é a WebP provisória; o polling troca pelo PNG quando pronto. */
  bgJob?: UploadBgJobRef;
  /** Campos aditivos (PR 6 — pré-requisito do Editor): o backend sempre os
   *  envia; ficam opcionais aqui para não obrigar mock nenhum a mudar. */
  originalUrl?: string;
  fileName?: string;
  width?: number;
  height?: number;
}

/**
 * Validação local, idêntica à que os componentes já faziam inline. Devolve a
 * mensagem de erro ou `null` quando o arquivo está ok — mantendo o
 * comportamento atual (arquivo inválido avisa o usuário e NÃO conta como
 * "falha de upload").
 */
export function validateImageFile(file: File): string | null {
  if (!file.type.startsWith("image/")) {
    return "Apenas arquivos de imagem são permitidos";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return "O arquivo deve ter no máximo 20MB";
  }
  return null;
}

/**
 * Traduz a exceção em algo acionável para o usuário.
 *
 * O caso que motivou tudo isto: quando o nginx responde 504, a resposta não
 * passa pelo `@fastify/cors` e o browser a DESCARTA — o `fetch` rejeita com um
 * `TypeError` e o status **nunca fica observável**. Por isso não dá para
 * classificar por `response.status`: cai no ramo `network`.
 */
export function classifyUploadError(err: unknown): {
  kind: UploadErrorKind;
  message: string;
} {
  if (err instanceof UploadImageError) {
    return { kind: err.kind, message: err.message };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "canceled", message: "Upload cancelado" };
  }
  if (err instanceof TypeError) {
    return {
      kind: "network",
      message:
        "Não foi possível concluir o upload — o servidor de imagens pode estar sobrecarregado. Tente novamente em instantes.",
    };
  }
  if (err instanceof Error && err.message) {
    return { kind: "unknown", message: err.message };
  }
  return { kind: "unknown", message: "Erro ao fazer upload da imagem" };
}

export async function uploadProductImage(
  file: File,
  opts: UploadImageOptions,
): Promise<UploadImageResult> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    opts.timeoutMs ?? computeUploadTimeoutMs(file.size),
  );

  const forwardAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append(
      "removeBackground",
      opts.removeBackground ? "true" : "false",
    );
    // Sombra exige o recorte: só pede sombra se a remoção de fundo está ON.
    formData.append(
      "addShadow",
      opts.removeBackground && opts.addShadow ? "true" : "false",
    );
    // Campo só enviado quando pedido (clientes/telas sem async não mudam
    // NADA no corpo da requisição — retrocompatível byte-a-byte).
    if (opts.asyncBg && opts.removeBackground) {
      formData.append("asyncBg", "true");
    }

    // Ver invariantes 1 e 2 no topo: `fetch` nu + URL concatenada.
    const response = await fetch(`${getApiBaseUrl()}/upload/image`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({}) as { message?: string });
      throw new UploadImageError(
        error.message || "Erro ao fazer upload",
        "server",
        response.status,
      );
    }

    const result = (await response.json()) as {
      imageUrl: string;
      warning?: string;
      bgJob?: UploadBgJobRef;
      originalUrl?: string;
      fileName?: string;
      width?: number;
      height?: number;
    };
    return {
      url: result.imageUrl,
      warning: result.warning,
      ...(result.bgJob ? { bgJob: result.bgJob } : {}),
      ...(result.originalUrl ? { originalUrl: result.originalUrl } : {}),
      ...(result.fileName ? { fileName: result.fileName } : {}),
      ...(typeof result.width === "number" ? { width: result.width } : {}),
      ...(typeof result.height === "number" ? { height: result.height } : {}),
    };
  } catch (err) {
    // Distinguir NOSSO deadline de um cancelamento externo: os dois chegam aqui
    // como AbortError, mas só um é falha.
    if (timedOut) {
      throw new UploadImageError(
        "O servidor de imagens demorou demais para responder. Tente novamente em instantes.",
        "timeout",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forwardAbort);
  }
}

export interface UploadEditedImageInput {
  /** Blob exportado do canvas (PNG transparente ou JPEG opaco). */
  blob: Blob;
  /** Receita EditRecipeV1 serializável (o backend valida version===1). */
  recipe: unknown;
  /** Basename da imagem-base aberta no editor (ex.: "abc.png"). */
  sourceFileName: string;
  /** Basename do recorte usado como camada, quando havia. */
  cutoutFileName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Cliente do `POST /upload/image/edited` (Editor de Imagem, PR 6). Mesmas
 * TRÊS INVARIANTES de auth do topo do arquivo: fetch nu resolvido na chamada,
 * URL por concatenação com getApiBaseUrl(), nunca setar authorization.
 */
export async function uploadEditedImage(
  input: UploadEditedImageInput,
): Promise<{ url: string; fileName: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    input.timeoutMs ?? computeUploadTimeoutMs(input.blob.size),
  );
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const formData = new FormData();
    const ext = input.blob.type === "image/jpeg" ? "jpg" : "png";
    formData.append("file", input.blob, `edited.${ext}`);
    formData.append("recipe", JSON.stringify(input.recipe));
    formData.append("sourceFileName", input.sourceFileName);
    if (input.cutoutFileName) {
      formData.append("cutoutFileName", input.cutoutFileName);
    }

    const response = await fetch(`${getApiBaseUrl()}/upload/image/edited`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({}) as { message?: string });
      throw new UploadImageError(
        error.message || "Erro ao salvar a imagem editada",
        "server",
        response.status,
      );
    }
    const result = (await response.json()) as {
      imageUrl: string;
      fileName: string;
    };
    return { url: result.imageUrl, fileName: result.fileName };
  } catch (err) {
    if (timedOut) {
      throw new UploadImageError(
        "O servidor de imagens demorou demais para responder. Tente novamente em instantes.",
        "timeout",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}

export interface ImageEditMeta {
  fileName: string;
  originalFileName?: string;
  originalUrl?: string;
  edit?: {
    recipe: unknown;
    sourceFileName: string;
    sourceUrl: string;
    cutoutFileName?: string;
    cutoutUrl?: string;
  };
}

export interface EditorAssetRef {
  id: string;
  fileName: string;
  label: string | null;
  url: string;
}

/** Biblioteca de veículos do editor (PR 7). Mesmas 3 invariantes de auth. */
export async function listEditorAssets(): Promise<EditorAssetRef[]> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/upload/image/assets`);
    if (!response.ok) return [];
    const json = (await response.json()) as { assets?: EditorAssetRef[] };
    return json.assets ?? [];
  } catch {
    return [];
  }
}

export async function registerEditorAsset(input: {
  fileName: string;
  label?: string;
}): Promise<EditorAssetRef | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/upload/image/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { asset?: EditorAssetRef };
    return json.asset ?? null;
  } catch {
    return null;
  }
}

export async function deleteEditorAsset(id: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/upload/image/assets/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** Cliente do `GET /upload/image/meta` — contexto para reabrir no editor.
 *  Timeout de 10s: um hang aqui seguraria a abertura do dialog para sempre
 *  (falha vira null e o editor segue com a própria URL exibida). */
export async function fetchImageEditMeta(
  fileName: string,
  timeoutMs = 10_000,
): Promise<ImageEditMeta | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/upload/image/meta?fileName=${encodeURIComponent(fileName)}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    return (await response.json()) as ImageEditMeta;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

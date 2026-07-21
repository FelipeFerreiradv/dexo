import { afterEach, describe, expect, it, vi } from "vitest";

import { getApiBaseUrl } from "../lib/api";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_TIMEOUT_BASE_MS,
  UploadImageError,
  classifyUploadError,
  computeUploadTimeoutMs,
  uploadProductImage,
  validateImageFile,
} from "../lib/upload-image";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeFile(
  { type = "image/jpeg", size = 1024, name = "foto.jpg" } = {},
): File {
  const file = new File([new Uint8Array(8)], name, { type });
  // `size` é readonly num File real — sobrescreve só quando o teste precisa.
  if (size !== 8) Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("validateImageFile", () => {
  it("recusa arquivo que não é imagem", () => {
    expect(validateImageFile(makeFile({ type: "application/pdf" }))).toBe(
      "Apenas arquivos de imagem são permitidos",
    );
  });

  it("recusa acima de 20MB", () => {
    expect(validateImageFile(makeFile({ size: MAX_UPLOAD_BYTES + 1 }))).toBe(
      "O arquivo deve ter no máximo 20MB",
    );
  });

  it("aceita imagem dentro do limite", () => {
    expect(validateImageFile(makeFile())).toBeNull();
  });
});

describe("computeUploadTimeoutMs", () => {
  // REGRESSÃO: o relógio do AbortController começa ANTES do fetch, então cobre
  // também a subida do arquivo — que o orçamento de 45s do servidor NÃO cobre
  // (o nginx bufferiza o corpo antes de repassar). Um valor fixo abortaria
  // uploads lentos-porém-bem-sucedidos e, como `imageUrl` é obrigatório no
  // formulário, BLOQUEARIA a criação do produto.
  it("nunca fica abaixo do orçamento do servidor, nem para arquivo minúsculo", () => {
    expect(computeUploadTimeoutMs(0)).toBeGreaterThanOrEqual(
      UPLOAD_TIMEOUT_BASE_MS,
    );
    // Servidor responde em ~48s no pior caso; o cliente não pode preemptar.
    expect(computeUploadTimeoutMs(1024)).toBeGreaterThan(48_000);
  });

  it("escala com o tamanho do arquivo (uplink lento de 4G)", () => {
    const seis = computeUploadTimeoutMs(6 * 1024 * 1024);
    const vinte = computeUploadTimeoutMs(MAX_UPLOAD_BYTES);

    expect(seis).toBeGreaterThan(computeUploadTimeoutMs(0));
    expect(vinte).toBeGreaterThan(seis);
    // 20MB a ~128 KB/s levam ~160s só de subida — o deadline precisa cobrir.
    expect(vinte).toBeGreaterThan(160_000);
  });

  it("é robusto a tamanho inválido", () => {
    expect(computeUploadTimeoutMs(-1)).toBe(UPLOAD_TIMEOUT_BASE_MS);
  });
});

describe("classifyUploadError", () => {
  it("trata TypeError como sobrecarga/rede — o caso do 504 sem CORS", () => {
    // Quando o nginx gera o 504, a resposta não passa pelo @fastify/cors, o
    // browser a descarta e o fetch rejeita com TypeError. O status NUNCA fica
    // observável, então classificar por response.status é impossível aqui.
    const out = classifyUploadError(new TypeError("Failed to fetch"));
    expect(out.kind).toBe("network");
    expect(out.message).toMatch(/sobrecarregado/i);
  });

  it("preserva kind e mensagem de um UploadImageError", () => {
    const err = new UploadImageError("Tipo de arquivo inválido", "server", 400);
    expect(classifyUploadError(err)).toEqual({
      kind: "server",
      message: "Tipo de arquivo inválido",
    });
  });

  it("distingue cancelamento de falha", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyUploadError(abort).kind).toBe("canceled");
  });

  it("tem fallback para valores não-Error", () => {
    expect(classifyUploadError("qualquer coisa").kind).toBe("unknown");
    expect(classifyUploadError(null).message).toBeTruthy();
  });
});

describe("uploadProductImage", () => {
  it("usa o fetch GLOBAL resolvido em tempo de chamada (ponte de auth)", async () => {
    // GUARDA ANTI-REGRESSÃO: o Authorization Bearer é injetado por um
    // monkey-patch em window.fetch (components/api-auth-bridge.tsx). Se alguém
    // capturar `fetch` em escopo de módulo, o patch é ignorado e a chamada toma
    // 401 silencioso em produção. Este stub é instalado DEPOIS do import — só
    // passa se o helper resolver o global na hora da chamada.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ imageUrl: "https://cdn/x.png" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A URL precisa ser a concatenação crua — o patch casa por startsWith.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${getApiBaseUrl()}/upload/image`);
    expect(init.method).toBe("POST");
    // E o helper NÃO pode setar authorization: o patch pula a injeção se o
    // header já existir.
    expect(init.headers).toBeUndefined();
    expect(init.signal).toBeDefined();
  });

  it("devolve url e warning do backend (degradação graceful)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          imageUrl: "https://cdn/x.webp",
          warning: "Remoção de fundo indisponível; usamos a imagem otimizada original.",
        }),
      }),
    );

    const result = await uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: true,
    });

    expect(result.url).toBe("https://cdn/x.webp");
    expect(result.warning).toMatch(/indisponível/);
  });

  it("envia addShadow=false quando removeBackground está desligado", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ imageUrl: "https://cdn/x.webp" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadProductImage(makeFile(), {
      removeBackground: false,
      addShadow: true,
    });

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get("removeBackground")).toBe("false");
    // Sombra exige o recorte — sem ele, não se pede sombra.
    expect(body.get("addShadow")).toBe("false");
  });

  it("propaga a mensagem do backend em resposta não-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ message: "Apenas imagens JPEG, PNG e WebP" }),
      }),
    );

    await expect(
      uploadProductImage(makeFile(), {
        removeBackground: true,
        addShadow: false,
      }),
    ).rejects.toMatchObject({
      kind: "server",
      status: 400,
      message: "Apenas imagens JPEG, PNG e WebP",
    });
  });

  it("aborta no deadline e reporta como timeout, não como cancelamento", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );

    const promise = uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: true,
      timeoutMs: 20,
    });

    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
  });

  it("um cancelamento externo continua sendo cancelamento", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );

    const controller = new AbortController();
    const promise = uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: true,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();

    expect(classifyUploadError(await promise.catch((e) => e)).kind).toBe(
      "canceled",
    );
  });
});

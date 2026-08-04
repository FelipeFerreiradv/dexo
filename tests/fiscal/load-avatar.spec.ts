import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  loadTenantAvatar,
  __clearAvatarCache,
} from "../../app/fiscal/generators/load-avatar";

// ──────────────────────────────────────────────────────────────────
// EGRESS. Este módulo roda por DOWNLOAD de cupom, não uma vez por processo.
// Os testes travam as três defesas: leitura local em vez de HTTP, cache
// (inclusive negativo) e redução ao tamanho desenhado.
// ──────────────────────────────────────────────────────────────────

const UPLOADS = path.join(process.cwd(), "public", "uploads");
const NOME = "__test_avatar_egress.png";
const ARQUIVO = path.join(UPLOADS, NOME);

/** PNG 1x1 válido — o suficiente para o sharp decodificar. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fakeDb(avatarUrl: string | null) {
  const calls = { n: 0 };
  return {
    calls,
    user: {
      findUnique: async () => {
        calls.n++;
        return { avatarUrl };
      },
    },
  };
}

const envAntes = process.env.APP_BACKEND_URL;

beforeEach(() => {
  __clearAvatarCache();
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(ARQUIVO, PNG_1X1);
  process.env.APP_BACKEND_URL = "https://api.exemplo.com.br";
  vi.restoreAllMocks();
});

afterEach(() => {
  try {
    fs.unlinkSync(ARQUIVO);
  } catch {
    /* já removido */
  }
  if (envAntes === undefined) delete process.env.APP_BACKEND_URL;
  else process.env.APP_BACKEND_URL = envAntes;
  __clearAvatarCache();
  vi.restoreAllMocks();
});

describe("loadTenantAvatar — leitura local em vez de round-trip HTTP", () => {
  it("URL do próprio /uploads é lida do DISCO, sem fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = fakeDb(`https://api.exemplo.com.br/uploads/${NOME}`);

    const avatar = await loadTenantAvatar(db as never, "u-1");

    expect(avatar).not.toBeNull();
    expect(avatar?.format).toBe("png");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caminho relativo /uploads/... também é lido do disco", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const avatar = await loadTenantAvatar(fakeDb(`/uploads/${NOME}`) as never, "u-2");
    expect(avatar).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("URL EXTERNA continua indo por HTTP (comportamento preservado)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(PNG_1X1, { status: 200, headers: { "content-type": "image/png" } }),
      );
    const avatar = await loadTenantAvatar(
      fakeDb("https://cdn.terceiro.com/logo.png") as never,
      "u-3",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(avatar).not.toBeNull();
  });

  it("arquivo local ausente cai no HTTP em vez de falhar", async () => {
    fs.unlinkSync(ARQUIVO);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(PNG_1X1, { status: 200 }));
    const avatar = await loadTenantAvatar(
      fakeDb(`https://api.exemplo.com.br/uploads/${NOME}`) as never,
      "u-4",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(avatar).not.toBeNull();
  });

  it("não sai de public/uploads mesmo com path traversal na URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(PNG_1X1, { status: 200 }));
    // basename() colapsa o traversal; o arquivo não existe ⇒ cai no HTTP.
    await loadTenantAvatar(fakeDb("/uploads/../../../../etc/passwd") as never, "u-5");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("loadTenantAvatar — cache (o papel que o logoBytesCache tinha)", () => {
  it("10 downloads do mesmo tenant = 1 query e 1 leitura", async () => {
    const db = fakeDb(`/uploads/${NOME}`);
    const readSpy = vi.spyOn(fs.promises, "readFile");

    for (let i = 0; i < 10; i++) {
      const a = await loadTenantAvatar(db as never, "u-cache");
      expect(a).not.toBeNull();
    }
    expect(db.calls.n).toBe(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it("CACHE NEGATIVO: avatar quebrado não repete o fetch a cada download", async () => {
    const db = fakeDb("https://cdn.terceiro.com/sumiu.png");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));

    for (let i = 0; i < 10; i++) {
      expect(await loadTenantAvatar(db as never, "u-404")).toBeNull();
    }
    // Sem cache negativo seriam 10 queries e 10 requisições 404.
    expect(db.calls.n).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("tenant SEM avatar não paga nada além da primeira query", async () => {
    const db = fakeDb(null);
    for (let i = 0; i < 5; i++) {
      expect(await loadTenantAvatar(db as never, "u-sem")).toBeNull();
    }
    expect(db.calls.n).toBe(1);
  });

  it("o cache é por TENANT — não vaza imagem entre clientes", async () => {
    const a = await loadTenantAvatar(fakeDb(`/uploads/${NOME}`) as never, "tenant-A");
    expect(a).not.toBeNull();

    // Outro tenant, sem avatar: tem que ler o PRÓPRIO valor, não o do vizinho.
    const dbB = fakeDb(null);
    const b = await loadTenantAvatar(dbB as never, "tenant-B");
    expect(b).toBeNull();
    expect(dbB.calls.n).toBe(1);
  });
});

describe("loadTenantAvatar — tamanho embutido", () => {
  it("reduz ao tamanho desenhado (não embute a imagem original inteira)", async () => {
    // 600x600 sólido: original grande, saída tem que caber no círculo de 40pt.
    const sharp = (await import("sharp")).default;
    const grande = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 10, g: 90, b: 200 } },
    })
      .png()
      .toBuffer();
    fs.writeFileSync(ARQUIVO, grande);

    const avatar = await loadTenantAvatar(fakeDb(`/uploads/${NOME}`) as never, "u-big");
    expect(avatar).not.toBeNull();

    const meta = await sharp(Buffer.from(avatar!.bytes)).metadata();
    expect(meta.width).toBeLessThanOrEqual(120);
    expect(meta.height).toBeLessThanOrEqual(120);
    expect(avatar!.bytes.length).toBeLessThan(grande.length);
  });

  it("imagem menor que o alvo não é ampliada", async () => {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from(
      (await loadTenantAvatar(fakeDb(`/uploads/${NOME}`) as never, "u-1x1"))!.bytes,
    )).metadata();
    expect(meta.width).toBe(1);
  });
});

describe("loadTenantAvatar — robustez (nunca lança, nunca derruba o cupom)", () => {
  it("banco fora do ar → null", async () => {
    const db = {
      user: {
        findUnique: async () => {
          throw new Error("banco fora");
        },
      },
    };
    expect(await loadTenantAvatar(db as never, "u-erro")).toBeNull();
  });

  it("fetch que rejeita → null", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("rede fora"));
    expect(
      await loadTenantAvatar(fakeDb("https://cdn.terceiro.com/x.png") as never, "u-rede"),
    ).toBeNull();
  });

  it("bytes que não são imagem → null, sem lançar", async () => {
    fs.writeFileSync(ARQUIVO, Buffer.from("isto nao e uma imagem"));
    const a = await loadTenantAvatar(fakeDb(`/uploads/${NOME}`) as never, "u-lixo");
    expect(a).toBeNull();
  });

  it("avisa UMA vez por falha, não a cada download (convenção de log do repo)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const db = fakeDb("https://cdn.terceiro.com/sumiu-log.png");
    for (let i = 0; i < 5; i++) await loadTenantAvatar(db as never, "u-log");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

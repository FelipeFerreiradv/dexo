import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { fastify, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import {
  cacheControlFor,
  IMMUTABLE_CACHE_CONTROL,
  isImmutableUploadPath,
  REVALIDATE_CACHE_CONTROL,
} from "../app/lib/static-cache";

/**
 * O risco desta mudança NÃO é o cache em si — é o escopo. O `root` do
 * `@fastify/static` é `public/` inteiro, e um `immutable` largo demais
 * congelaria por um ANO um logo/ícone trocado no deploy, sem invalidação
 * possível. Estes testes existem para prender o escopo.
 */
describe("isImmutableUploadPath — escopo do cache imutável", () => {
  const ROOT = join("/srv", "dexo");
  const up = (name: string) => join(ROOT, "public", "uploads", name);
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  it("marca os arquivos que o upload gera", () => {
    expect(isImmutableUploadPath(up(`${UUID}.webp`), ROOT)).toBe(true);
    expect(isImmutableUploadPath(up(`${UUID}.png`), ROOT)).toBe(true);
    expect(isImmutableUploadPath(up(`${UUID}.orig.jpg`), ROOT)).toBe(true);
    expect(isImmutableUploadPath(up(`${UUID}.orig.webp`), ROOT)).toBe(true);
    expect(isImmutableUploadPath(up(`${UUID}.orig.bin`), ROOT)).toBe(true);
  });

  it("NÃO marca assets do deploy (o logo trocado tem que propagar)", () => {
    expect(isImmutableUploadPath(join(ROOT, "public", "logo.jpg"), ROOT)).toBe(
      false,
    );
    expect(
      isImmutableUploadPath(join(ROOT, "public", "icon-192.png"), ROOT),
    ).toBe(false);
    expect(
      isImmutableUploadPath(
        join(ROOT, "public", "api-docs", "index.html"),
        ROOT,
      ),
    ).toBe(false);
    expect(
      isImmutableUploadPath(
        join(ROOT, "public", "marketplaces", "ml.svg"),
        ROOT,
      ),
    ).toBe(false);
  });

  it("NÃO marca arquivo de uploads que não seja nomeado por UUID", () => {
    expect(isImmutableUploadPath(up("logo.jpg"), ROOT)).toBe(false);
    expect(isImmutableUploadPath(up("foto-do-cliente.png"), ROOT)).toBe(false);
    // Prefixo parecido mas incompleto não conta.
    expect(isImmutableUploadPath(up("3f2504e0-4f89.png"), ROOT)).toBe(false);
    // UUID sem sufixo: o upload sempre gera com extensão.
    expect(isImmutableUploadPath(up(UUID), ROOT)).toBe(false);
  });

  it("não vaza para diretórios vizinhos com prefixo parecido", () => {
    expect(
      isImmutableUploadPath(join(ROOT, "public", "uploads-old", `${UUID}.webp`), ROOT),
    ).toBe(false);
    expect(
      isImmutableUploadPath(join(ROOT, "private", "uploads", `${UUID}.webp`), ROOT),
    ).toBe(false);
  });

  it("o header é cacheável e imutável por um ano", () => {
    expect(IMMUTABLE_CACHE_CONTROL).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});

/**
 * O predicado acima é puro; o que ele NÃO prova é que o `setHeaders` do
 * `@fastify/static` de fato aplica o header na resposta. Este bloco sobe um
 * static real (sem tocar no `api.ts`, que instancia o servidor inteiro no
 * import) e confere o header que sai no fio.
 */
describe("@fastify/static — o header chega na resposta", () => {
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  let root = "";
  let app: FastifyInstance;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dexo-static-"));
    await mkdir(join(root, "public", "uploads"), { recursive: true });
    await writeFile(join(root, "public", "uploads", `${UUID}.webp`), "img");
    await writeFile(join(root, "public", "logo.jpg"), "logo");

    app = fastify();
    // Espelha EXATAMENTE a registração de `app/api/api.ts`.
    await app.register(fastifyStatic, {
      root: join(root, "public"),
      prefix: "/",
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.setHeader("Cache-Control", cacheControlFor(filePath, root));
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("imagem de upload sai com immutable", async () => {
    const res = await app.inject({ url: `/uploads/${UUID}.webp` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it("asset do deploy mantém o comportamento anterior (revalidação)", async () => {
    const res = await app.inject({ url: "/logo.jpg" });
    expect(res.statusCode).toBe(200);
    // Byte a byte o que o @fastify/static já respondia: revalida, nunca congela.
    expect(res.headers["cache-control"]).toBe(REVALIDATE_CACHE_CONTROL);
    expect(res.headers["etag"]).toBeDefined();
  });

  it("o 304 condicional continua funcionando para os assets do deploy", async () => {
    const first = await app.inject({ url: "/logo.jpg" });
    const etag = first.headers["etag"] as string;
    const second = await app.inject({
      url: "/logo.jpg",
      headers: { "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
  });
});

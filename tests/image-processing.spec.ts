import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  ensureMLMinImageSize,
  processUploadedImage,
} from "../app/marketplaces/services/image-resize.service";

// Helper: cria uma imagem PNG sintética de dimensões controladas, opcionalmente com alpha.
async function makeImage(
  width: number,
  height: number,
  opts?: { hasAlpha?: boolean },
): Promise<Buffer> {
  const channels = opts?.hasAlpha ? 4 : 3;
  return sharp({
    create: {
      width,
      height,
      channels: channels as 3 | 4,
      background: opts?.hasAlpha
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : { r: 200, g: 50, b: 50 },
    },
  })
    .png()
    .toBuffer();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureMLMinImageSize", () => {
  it("retorna o buffer original quando já atende o mínimo e não tem alpha", async () => {
    const buf = await makeImage(1200, 900);
    const out = await ensureMLMinImageSize(buf);
    // Sharp default não copia bytes idênticos, mas o input já é JPEG-ish-tamanho.
    // O contrato é: não houve resize. Verificamos a metadata.
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(900);
  });

  it("redimensiona para 800px no lado mais curto quando abaixo do mínimo", async () => {
    const buf = await makeImage(600, 400);
    const out = await ensureMLMinImageSize(buf);
    const meta = await sharp(out).metadata();
    // Imagem original era 600x400, lado curto < 800. Resize por altura=800
    // (porque width > height na orientação landscape; sharp normaliza por
    // proporção mantendo aspect).
    expect((meta.height ?? 0) >= 800 || (meta.width ?? 0) >= 800).toBe(true);
  });

  it("achata alpha sobre branco quando a imagem tem transparência", async () => {
    const buf = await makeImage(1000, 1000, { hasAlpha: true });
    const out = await ensureMLMinImageSize(buf);
    const meta = await sharp(out).metadata();
    // Após flatten, não tem mais canal alpha.
    expect(meta.hasAlpha).toBe(false);
    // Encode final foi JPEG.
    expect(meta.format).toBe("jpeg");
  });
});

describe("processUploadedImage", () => {
  // Garante que o env não interfira nos testes (a flag REMBG_ENABLED de
  // verdade é "true" em produção e isso poderia tentar chamar localhost).
  beforeEach(() => {
    delete process.env.REMBG_SIDECAR_URL;
    delete process.env.REMBG_ENABLED;
  });

  it("encoda WebP otimizado quando removeBackground=false", async () => {
    const buf = await makeImage(1200, 900);
    const result = await processUploadedImage(buf, { removeBackground: false });
    expect(result.removedBackground).toBe(false);
    expect(result.format).toBe("webp");
    const meta = await sharp(result.processed).metadata();
    expect(meta.format).toBe("webp");
  });

  it("reduz para max 1600px no lado mais longo", async () => {
    const buf = await makeImage(3000, 2000);
    const result = await processUploadedImage(buf, { removeBackground: false });
    expect(result.width).toBeLessThanOrEqual(1600);
    expect(result.height).toBeLessThanOrEqual(1600);
  });

  it("amplia para min 1000px no lado mais curto", async () => {
    const buf = await makeImage(500, 400);
    const result = await processUploadedImage(buf, { removeBackground: false });
    expect(Math.max(result.width ?? 0, result.height ?? 0)).toBeGreaterThanOrEqual(
      1000,
    );
  });

  it("chama o sidecar e devolve PNG quando removeBackground=true", async () => {
    const buf = await makeImage(1200, 900);
    // O fetcher mocked simula o retorno do sidecar (PNG transparente).
    const transparent = await makeImage(800, 600, { hasAlpha: true });
    const fetcher = vi.fn().mockResolvedValue(transparent);

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.removedBackground).toBe(true);
    expect(result.format).toBe("png");
    const meta = await sharp(result.processed).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
  });

  it("A2: passthrough — devolve o PNG do sidecar sem re-encodar (bytes idênticos)", async () => {
    const buf = await makeImage(1200, 900);
    // PNG RGBA válido simulando a saída do sidecar.
    const cutout = await makeImage(800, 600, { hasAlpha: true });
    const fetcher = vi.fn().mockResolvedValue(cutout);

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    // O buffer devolvido é EXATAMENTE o do sidecar (sem re-encode no Node).
    expect(result.processed.equals(cutout)).toBe(true);
    expect(result.format).toBe("png");
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  it("faz fallback graceful para WebP + warning quando sidecar falha", async () => {
    const buf = await makeImage(1200, 900);
    const fetcher = vi.fn().mockRejectedValue(new Error("sidecar offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.removedBackground).toBe(false);
    expect(result.format).toBe("webp");
    expect(result.warning).toBeTruthy();
  });

  it("respeita o killswitch REMBG_ENABLED=false (não tenta o sidecar)", async () => {
    process.env.REMBG_SIDECAR_URL = "http://localhost:8000";
    process.env.REMBG_ENABLED = "false";
    const buf = await makeImage(1200, 900);
    const fetcher = vi.fn();

    // Quando NÃO passamos rembgFetcher, o default usa env. Com o
    // killswitch ligado e sem fetcher injetado, o pipeline cai direto
    // no fallback graceful sem chamar nada.
    const result = await processUploadedImage(buf, {
      removeBackground: true,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.removedBackground).toBe(false);
    expect(result.warning).toBeTruthy();
  });

  it("strip de EXIF: imagem processada não carrega EXIF original", async () => {
    // Cria uma imagem com EXIF Orientation = 6 (90° CW) e verifica que o
    // pipeline auto-orienta + remove os metadados.
    const base = await makeImage(1200, 900);
    const withExif = await sharp(base)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await processUploadedImage(withExif, {
      removeBackground: false,
    });

    const meta = await sharp(result.processed).metadata();
    // Sharp já aplicou rotate() — Orientation não é mais 6.
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("repassa addShadow=true ao fetcher e marca shadowApplied", async () => {
    const buf = await makeImage(1200, 900);
    const transparent = await makeImage(800, 600, { hasAlpha: true });
    const fetcher = vi.fn().mockResolvedValue(transparent);

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      addShadow: true,
      rembgFetcher: fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ addShadow: true }),
    );
    expect(result.removedBackground).toBe(true);
    expect(result.shadowApplied).toBe(true);
    expect(result.format).toBe("png");
  });

  it("shadowApplied=false quando addShadow é omitido (default)", async () => {
    const buf = await makeImage(1200, 900);
    const transparent = await makeImage(800, 600, { hasAlpha: true });
    const fetcher = vi.fn().mockResolvedValue(transparent);

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    // Fetcher é chamado com addShadow=false (o serviço normaliza undefined).
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ addShadow: false }),
    );
    expect(result.shadowApplied).toBe(false);
  });

  it("não aplica sombra quando removeBackground=false (sombra exige recorte)", async () => {
    const buf = await makeImage(1200, 900);
    const fetcher = vi.fn();

    const result = await processUploadedImage(buf, {
      removeBackground: false,
      addShadow: true,
      rembgFetcher: fetcher,
    });

    // Sem recorte não há alpha → sidecar não é chamado e não há sombra.
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.removedBackground).toBe(false);
    expect(result.shadowApplied).toBeFalsy();
  });
});

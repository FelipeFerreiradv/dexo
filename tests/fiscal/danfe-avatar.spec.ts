import { describe, it, expect } from "vitest";
import { normalizeAvatarBytes } from "../../app/fiscal/generators/danfe-avatar";

// ──────────────────────────────────────────────────────────────────────────
// C3 — Logo do emitente no DANFE.
//
// Causa real: o upload do app gera WebP quando "remover fundo" está desligado
// (caso típico de uma LOGO), e o pdf-lib só embute PNG/JPG. normalizeAvatarBytes
// passa PNG/JPG direto e transcoda WebP/etc. para PNG via sharp. Best-effort:
// qualquer falha → null (renderer cai nas iniciais), nunca lança.
// ──────────────────────────────────────────────────────────────────────────

async function makeImage(format: "png" | "jpeg" | "webp"): Promise<Uint8Array> {
  const mod = await import("sharp");
  const sharp = (mod as any).default || mod;
  const buf = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    [format]()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("normalizeAvatarBytes — logo do emitente p/ DANFE", () => {
  it("PNG passa direto (format png, mesma referência de bytes)", async () => {
    const png = await makeImage("png");
    const out = await normalizeAvatarBytes(png);
    expect(out?.format).toBe("png");
    expect(out?.bytes).toBe(png); // fast-path sem transcode
  });

  it("JPG passa direto (format jpg, magic FF D8)", async () => {
    const jpg = await makeImage("jpeg");
    const out = await normalizeAvatarBytes(jpg);
    expect(out?.format).toBe("jpg");
    expect(out?.bytes[0]).toBe(0xff);
    expect(out?.bytes[1]).toBe(0xd8);
  });

  it("WebP é transcodado para PNG (corrige a logo que não aparecia)", async () => {
    const webp = await makeImage("webp");
    const out = await normalizeAvatarBytes(webp);
    expect(out?.format).toBe("png");
    // saída começa com o magic de PNG (89 50 4E 47)
    expect(out?.bytes[0]).toBe(0x89);
    expect(out?.bytes[1]).toBe(0x50);
    expect(out?.bytes[2]).toBe(0x4e);
    expect(out?.bytes[3]).toBe(0x47);
  });

  it("bytes inválidos → null (sem lançar)", async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    await expect(normalizeAvatarBytes(garbage)).resolves.toBeNull();
  });

  it("bytes curtos/ausentes → null", async () => {
    expect(await normalizeAvatarBytes(new Uint8Array([0xff]))).toBeNull();
    expect(await normalizeAvatarBytes(null)).toBeNull();
    expect(await normalizeAvatarBytes(undefined)).toBeNull();
  });
});

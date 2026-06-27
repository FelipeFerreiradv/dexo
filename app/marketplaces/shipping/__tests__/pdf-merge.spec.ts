import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mergePdfs, composeA4 } from "../pdf-merge";

// 283x425 pt ≈ 10×15 cm (formato de etiqueta). Cada página recebe um retângulo
// para ter content stream (embedPdf rejeita página vazia; etiquetas reais têm
// conteúdo).
async function makePdf(pages: number, w = 283, h = 425): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    p.drawRectangle({ x: 10, y: 10, width: w - 20, height: h - 20 });
  }
  return Buffer.from(await doc.save());
}

describe("pdf-merge", () => {
  it("mergePdfs concatena as páginas de vários PDFs", async () => {
    const merged = await mergePdfs([await makePdf(1), await makePdf(2)]);
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(3);
  });

  it("mergePdfs ignora buffers vazios", async () => {
    const merged = await mergePdfs([await makePdf(1), Buffer.alloc(0)]);
    expect((await PDFDocument.load(merged)).getPageCount()).toBe(1);
  });

  it("composeA4 perPage=3: até 3 etiquetas em 1 folha A4 (595×842)", async () => {
    const out = await composeA4(await makePdf(3), 3);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
    expect(Math.round(doc.getPage(0).getHeight())).toBe(842);
  });

  it("composeA4 perPage=3 com 4 etiquetas → 2 folhas A4", async () => {
    const out = await composeA4(await makePdf(4), 3);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });

  it("composeA4 perPage=1 → 1 folha A4 por etiqueta", async () => {
    const out = await composeA4(await makePdf(2), 1);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
  });
});

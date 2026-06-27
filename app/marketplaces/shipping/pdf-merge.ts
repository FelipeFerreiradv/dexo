/**
 * Utilidades de PDF para o módulo de etiqueta (reutiliza pdf-lib, já no projeto
 * — sem dependência nova). Usado no lote (juntar etiquetas) e na composição A4.
 */
import { PDFDocument } from "pdf-lib";

/** Dimensões A4 em pontos (72 dpi). */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

/**
 * Concatena vários PDFs num único (todas as páginas em sequência, na ordem).
 * PDFs vazios/inválidos são ignorados (best-effort).
 */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    if (!buf || buf.length === 0) continue;
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}

/**
 * Compõe as etiquetas de um PDF (cada página ~10×15) em folhas A4, `perPage`
 * por folha (empilhadas verticalmente, do topo para baixo). Cada etiqueta é
 * escalada para caber no slot mantendo a proporção, centralizada.
 *
 * - individual (1 etiqueta) → use perPage=1 (etiqueta grande, centralizada).
 * - lote → perPage=3 (3 etiquetas por folha A4).
 */
export async function composeA4(buffer: Buffer, perPage = 3): Promise<Buffer> {
  const slots = Math.max(1, perPage);
  const src = await PDFDocument.load(buffer);
  const indices = src.getPageIndices();
  if (indices.length === 0) return buffer;

  const out = await PDFDocument.create();
  const embedded = await out.embedPdf(buffer, indices);

  const slotH = A4_HEIGHT / slots;
  const margin = 12;
  let page: import("pdf-lib").PDFPage | null = null;

  for (let i = 0; i < embedded.length; i++) {
    const slot = i % slots;
    if (slot === 0) {
      page = out.addPage([A4_WIDTH, A4_HEIGHT]);
    }
    const emb = embedded[i];
    const maxW = A4_WIDTH - margin * 2;
    const maxH = slotH - margin * 2;
    const scale = Math.min(maxW / emb.width, maxH / emb.height);
    const w = emb.width * scale;
    const h = emb.height * scale;
    const x = (A4_WIDTH - w) / 2;
    // slot 0 no topo: faixa [H - (slot+1)*slotH, H - slot*slotH]
    const slotBottom = A4_HEIGHT - (slot + 1) * slotH;
    const y = slotBottom + (slotH - h) / 2;
    page!.drawPage(emb, { x, y, width: w, height: h });
  }

  const bytes = await out.save();
  return Buffer.from(bytes);
}

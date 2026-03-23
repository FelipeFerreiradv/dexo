import type { PDFFont } from "pdf-lib";

export interface LabelProduct {
  id: string;
  sku?: string | null;
  name?: string | null;
  partNumber?: string | null;
}

interface GenerateLabelsPdfParams {
  products: LabelProduct[];
  userName?: string | null;
}

const LABEL_QR_URL = "https://usedexo.com.br/produtos";
const pdfLibPromise = import("pdf-lib");
const qrLibPromise = import("qrcode");
let cachedQrDataUrl: string | null = null;

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const sanitized = text.replace(/\s+/g, " ").trim();
  if (!sanitized) return [];

  const words = sanitized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(next, size);
    if (width <= maxWidth) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
    } else {
      // Word longer than max width â€“ split hard
      lines.push(word);
    }
    current = word;

    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  // Truncate last line if still too long
  if (lines.length === maxLines) {
    const last = lines[lines.length - 1];
    let truncated = last;
    while (
      font.widthOfTextAtSize(truncated, size) > maxWidth &&
      truncated.length > 3
    ) {
      truncated = `${truncated.slice(0, -2)}...`;
    }
    lines[lines.length - 1] = truncated;
  }

  return lines;
}

export async function generateLabelsPdf({
  products,
  userName,
}: GenerateLabelsPdfParams) {
  if (!products || products.length === 0) {
    throw new Error("Nenhum produto selecionado");
  }

  if (typeof window === "undefined") {
    throw new Error("Geracao de etiquetas disponivel apenas no cliente");
  }

  const [{ PDFDocument, StandardFonts, rgb }, QRCode] = await Promise.all([
    pdfLibPromise,
    qrLibPromise,
  ]);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  if (!cachedQrDataUrl) {
    cachedQrDataUrl = await QRCode.toDataURL(LABEL_QR_URL, {
      width: 260,
      margin: 0,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }
  const qrImage = await pdfDoc.embedPng(cachedQrDataUrl);

  const safeUserName = (userName || "UsuÃ¡rio").toUpperCase();

  products.forEach((product) => {
    const pageWidth = 520;
    const pageHeight = 260;
    const margin = 20;
    const qrSize = 170;

    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const { height } = page.getSize();
    page.setFont(font);
    page.setFontSize(12);
    page.setFontColor(rgb(0, 0, 0));

    const qrX = margin;
    const qrY = height - margin - qrSize;
    page.drawImage(qrImage, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    });

    const rightX = qrX + qrSize + 22;
    const rightWidth = pageWidth - rightX - margin;

    // Header: user name
    page.drawText(safeUserName, {
      x: rightX,
      y: height - margin - 10,
      size: 16,
      font: fontBold,
    });

    // Product number (SKU preferred)
    const numberText = (product.sku || product.id || "S/N").toString();
    let numberSize = 34;
    const numberWidth = fontBold.widthOfTextAtSize(numberText, numberSize);
    if (numberWidth > rightWidth) {
      numberSize = Math.max(22, (rightWidth / numberWidth) * numberSize);
    }
    page.drawText(numberText, {
      x: rightX,
      y: height - margin - 50,
      size: numberSize,
      font: fontBold,
    });

    /*
     * Part number ocultado por solicitação.
     * Mantido comentado para futura reativação rápida.
     *
     * const partNumberText = product.partNumber?.trim() || "Sem part number";
     * const partLabel = `PN: ${partNumberText}`;
     * let partSize = 14;
     * const partWidth = font.widthOfTextAtSize(partLabel, partSize);
     * if (partWidth > rightWidth) {
     *   partSize = Math.max(10, (rightWidth / partWidth) * partSize);
     * }
     * page.drawText(partLabel, {
     *   x: rightX,
     *   y: height - margin - 82,
     *   size: partSize,
     *   font,
     * });
     */

    // Product name (wrapped)
    const nameText = product.name?.trim() || "Produto sem nome";
    const wrappedName = wrapText(nameText, fontBold, 14, rightWidth, 2);
    let nameY = height - margin - 110;
    wrappedName.forEach((line) => {
      page.drawText(line, {
        x: rightX,
        y: nameY,
        size: 14,
        font: fontBold,
      });
      nameY -= 18;
    });

    // Footer URL (fixed)
    page.drawText("www.usedexo.com.br", {
      x: margin,
      y: margin,
      size: 12,
      font: fontBold,
    });
  });

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `etiquetas-${products.length}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

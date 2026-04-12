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

const pdfLibPromise = import("pdf-lib");
const qrLibPromise = import("qrcode");
const qrDataUrlCache = new Map<string, string>();

export function getProductUrl(productId: string): string {
  const base =
    typeof window !== "undefined"
      ? process.env.NEXT_PUBLIC_APP_URL || window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL || "";
  return `${base}/produtos/${productId}`;
}

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

  // Pre-compute unique product URLs once
  const productUrls = new Map<string, string>();
  for (const product of products) {
    if (!productUrls.has(product.id)) {
      productUrls.set(product.id, getProductUrl(product.id));
    }
  }

  // Generate QR data URLs for uncached URLs only
  const uncachedUrls = [...new Set(productUrls.values())].filter(
    (url) => !qrDataUrlCache.has(url),
  );
  if (uncachedUrls.length > 0) {
    await Promise.all(
      uncachedUrls.map(async (url) => {
        const dataUrl = await QRCode.toDataURL(url, {
          width: 260,
          margin: 0,
          color: { dark: "#000000", light: "#ffffff" },
        });
        qrDataUrlCache.set(url, dataUrl);
      }),
    );
  }

  // Embed unique QR PNG images into the PDF document in one pass
  const uniqueUrls = [...new Set(productUrls.values())];
  const qrImages = new Map<string, Awaited<ReturnType<typeof pdfDoc.embedPng>>>();
  await Promise.all(
    uniqueUrls.map(async (url) => {
      const img = await pdfDoc.embedPng(qrDataUrlCache.get(url)!);
      qrImages.set(url, img);
    }),
  );

  const safeUserName = (userName || "Usuário").toUpperCase();
  const footerHost = (
    process.env.NEXT_PUBLIC_APP_URL || "https://usedexo.com.br"
  ).replace(/^https?:\/\//, "");

  const pageWidth = 520;
  const pageHeight = 260;
  const margin = 20;
  const qrSize = 170;

  products.forEach((product) => {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const { height } = page.getSize();
    page.setFont(font);
    page.setFontSize(12);
    page.setFontColor(rgb(0, 0, 0));

    const productUrl = productUrls.get(product.id)!;
    const productQrImage = qrImages.get(productUrl)!;
    const qrX = margin;
    const qrY = height - margin - qrSize;
    page.drawImage(productQrImage, {
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

    // Footer URL
    page.drawText(footerHost, {
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

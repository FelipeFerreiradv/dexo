import { wrapText } from "@/app/lib/pdf-label-utils";
import { openPdfForPrint } from "@/app/lib/open-pdf-for-print";
import {
  MAX_TOTAL_LABELS,
  expandItemsToPages,
  validateStandaloneLabelItems,
  type StandaloneLabelItem,
} from "@/app/produtos/lib/standalone-labels";

// Gerador de PDF da "Etiqueta avulsa": análogo pré-produto do generateLabelsPdf
// de app/produtos/lib/labels-pdf.ts, para etiquetas de produtos que ainda NÃO
// existem. Diferenças em relação ao gerador de produto:
//   - o QR codifica o SKU cru (texto), não a URL /produtos/{id};
//   - não há `id` de produto — cada página vem de { name, sku } expandido.
// O layout (medidas, tipografia, posições) é replicado 1:1 do gerador de produto
// de propósito (decisão B): não importamos nem tocamos labels-pdf.ts, para que o
// PDF de produto continue byte a byte idêntico.

interface GenerateStandaloneLabelsPdfParams {
  items: StandaloneLabelItem[];
  userName?: string | null;
}

const pdfLibPromise = import("pdf-lib");
const qrLibPromise = import("qrcode");

export async function generateStandaloneLabelsPdf({
  items,
  userName,
}: GenerateStandaloneLabelsPdfParams) {
  if (typeof window === "undefined") {
    throw new Error("Geracao de etiquetas disponivel apenas no cliente");
  }

  const validation = validateStandaloneLabelItems(items);
  if (!validation.canGenerate) {
    if (!validation.hasValidRows) {
      throw new Error("Preencha ao menos uma etiqueta com nome e SKU");
    }
    if (!validation.allRowsValid) {
      throw new Error("Preencha nome e SKU em todas as etiquetas");
    }
    if (validation.overCap) {
      throw new Error(
        `Limite de ${MAX_TOTAL_LABELS} etiquetas por PDF excedido (${validation.totalLabels})`,
      );
    }
    throw new Error("Nenhuma etiqueta valida para gerar");
  }

  const pages = expandItemsToPages(items);
  // Backstop defensivo: a validação acima já bloqueia estes casos.
  if (pages.length === 0) {
    throw new Error("Nenhuma etiqueta valida para gerar");
  }
  if (pages.length > MAX_TOTAL_LABELS) {
    throw new Error(
      `Limite de ${MAX_TOTAL_LABELS} etiquetas por PDF excedido (${pages.length})`,
    );
  }

  const [{ PDFDocument, StandardFonts, rgb }, QRCode] = await Promise.all([
    pdfLibPromise,
    qrLibPromise,
  ]);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // QR de cada etiqueta = o SKU cru, para auto-vincular quando o produto for
  // criado depois com esse mesmo SKU (/scan/resolve busca por skuNormalized).
  // Dedup por SKU nesta chamada — SKUs iguais embedam a imagem uma vez só.
  const uniqueSkus = [...new Set(pages.map((page) => page.sku))];
  const qrImages = new Map<
    string,
    Awaited<ReturnType<typeof pdfDoc.embedPng>>
  >();
  await Promise.all(
    uniqueSkus.map(async (sku) => {
      const dataUrl = await QRCode.toDataURL(sku, {
        width: 260,
        margin: 0,
        color: { dark: "#000000", light: "#ffffff" },
      });
      qrImages.set(sku, await pdfDoc.embedPng(dataUrl));
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

  pages.forEach((item) => {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const { height } = page.getSize();
    page.setFont(font);
    page.setFontSize(12);
    page.setFontColor(rgb(0, 0, 0));

    const qrImage = qrImages.get(item.sku)!;
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

    // SKU em destaque (número grande) — equivalente ao product.sku do gerador
    // de produto. O SKU já vem com trim() de expandItemsToPages.
    const numberText = item.sku;
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

    // Nome do produto (com quebra de linha)
    const nameText = item.name || "Produto sem nome";
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
  return openPdfForPrint(blob, `etiquetas-avulsas-${pages.length}.pdf`);
}

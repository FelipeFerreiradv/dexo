import { wrapText } from "@/app/lib/pdf-label-utils";
import { getLocationScanUrl } from "@/app/lib/qr-payloads";

export interface LabelLocation {
  id: string;
  code: string;
  description?: string | null;
}

interface GenerateLocationLabelsPdfParams {
  locations: LabelLocation[];
  userName?: string | null;
}

const pdfLibPromise = import("pdf-lib");
const qrLibPromise = import("qrcode");
const qrDataUrlCache = new Map<string, string>();

export async function generateLocationLabelsPdf({
  locations,
  userName,
}: GenerateLocationLabelsPdfParams) {
  if (!locations || locations.length === 0) {
    throw new Error("Nenhuma localizacao selecionada");
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

  const locationUrls = new Map<string, string>();
  for (const loc of locations) {
    if (!locationUrls.has(loc.id)) {
      locationUrls.set(loc.id, getLocationScanUrl(loc.id));
    }
  }

  const uncachedUrls = [...new Set(locationUrls.values())].filter(
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

  const uniqueUrls = [...new Set(locationUrls.values())];
  const qrImages = new Map<
    string,
    Awaited<ReturnType<typeof pdfDoc.embedPng>>
  >();
  await Promise.all(
    uniqueUrls.map(async (url) => {
      const img = await pdfDoc.embedPng(qrDataUrlCache.get(url)!);
      qrImages.set(url, img);
    }),
  );

  const safeUserName = (userName || "Usuario").toUpperCase();
  const footerHost = (
    process.env.NEXT_PUBLIC_APP_URL || "https://usedexo.com.br"
  ).replace(/^https?:\/\//, "");

  const pageWidth = 520;
  const pageHeight = 260;
  const margin = 20;
  const qrSize = 170;

  // Cores
  const black = rgb(0, 0, 0);
  // Amarelo da identidade visual Dexo (--primary em app/globals.css ~ #F2CB05)
  const accentYellow = rgb(0.949, 0.796, 0.02);

  locations.forEach((loc) => {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const { height } = page.getSize();
    page.setFont(font);
    page.setFontSize(12);
    page.setFontColor(black);

    const locationUrl = locationUrls.get(loc.id)!;
    const qrImage = qrImages.get(locationUrl)!;
    const qrX = margin;
    const qrY = height - margin - qrSize;
    page.drawImage(qrImage, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    });

    // Borda lateral amarela para diferenciar visualmente da etiqueta de produto
    const sidebarX = qrX + qrSize + 10;
    const sidebarY = margin + 6;
    const sidebarH = height - margin - sidebarY;
    page.drawRectangle({
      x: sidebarX,
      y: sidebarY,
      width: 6,
      height: sidebarH,
      color: accentYellow,
    });

    const rightX = sidebarX + 6 + 14;
    const rightWidth = pageWidth - rightX - margin;

    // Badge "LOCALIZACAO" no topo direito
    const badgeText = "LOCALIZACAO";
    const badgeFontSize = 11;
    const badgePaddingX = 10;
    const badgePaddingY = 6;
    const badgeTextWidth = fontBold.widthOfTextAtSize(badgeText, badgeFontSize);
    const badgeWidth = badgeTextWidth + badgePaddingX * 2;
    const badgeHeight = badgeFontSize + badgePaddingY * 2;
    const badgeX = rightX;
    const badgeY = height - margin - badgeHeight;
    page.drawRectangle({
      x: badgeX,
      y: badgeY,
      width: badgeWidth,
      height: badgeHeight,
      color: accentYellow,
    });
    page.drawText(badgeText, {
      x: badgeX + badgePaddingX,
      y: badgeY + badgePaddingY + 1,
      size: badgeFontSize,
      font: fontBold,
      color: black,
    });

    // Nome do usuario: ocupa apenas o espaco a direita do badge.
    // Reduz a fonte (ate um minimo) e trunca com "..." se ainda nao couber.
    const userNameGap = 12;
    const userNameMaxWidth =
      pageWidth - margin - (badgeX + badgeWidth + userNameGap);
    let userNameSize = 12;
    let userNameText = safeUserName;
    let userNameWidth = font.widthOfTextAtSize(userNameText, userNameSize);
    if (userNameWidth > userNameMaxWidth) {
      userNameSize = Math.max(
        8,
        (userNameMaxWidth / userNameWidth) * userNameSize,
      );
      userNameWidth = font.widthOfTextAtSize(userNameText, userNameSize);
    }
    while (userNameWidth > userNameMaxWidth && userNameText.length > 3) {
      userNameText = `${userNameText.slice(0, -4).trimEnd()}...`;
      userNameWidth = font.widthOfTextAtSize(userNameText, userNameSize);
    }
    page.drawText(userNameText, {
      x: pageWidth - margin - userNameWidth,
      y: badgeY + badgePaddingY + 1,
      size: userNameSize,
      font,
      color: black,
    });

    // Codigo grande (sigla da localizacao)
    const codeText = (loc.code || "S/CODIGO").toString();
    let codeSize = 48;
    const codeWidth = fontBold.widthOfTextAtSize(codeText, codeSize);
    if (codeWidth > rightWidth) {
      codeSize = Math.max(26, (rightWidth / codeWidth) * codeSize);
    }
    page.drawText(codeText, {
      x: rightX,
      y: badgeY - 10 - codeSize,
      size: codeSize,
      font: fontBold,
      color: black,
    });

    // Descricao (opcional, wrapped 2 linhas)
    const descriptionText = loc.description?.trim();
    if (descriptionText) {
      const descLines = wrapText(descriptionText, font, 12, rightWidth, 2);
      let descY = badgeY - 10 - codeSize - 22;
      descLines.forEach((line) => {
        page.drawText(line, {
          x: rightX,
          y: descY,
          size: 12,
          font,
          color: black,
        });
        descY -= 16;
      });
    }

    // Footer URL
    page.drawText(footerHost, {
      x: margin,
      y: margin,
      size: 12,
      font: fontBold,
      color: black,
    });
  });

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `etiquetas-localizacoes-${locations.length}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

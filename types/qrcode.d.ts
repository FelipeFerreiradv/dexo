/**
 * Declaração ambiente mínima do pacote `qrcode` (^1.5) — sem @types oficial
 * instalado. Cobre a única API usada no repo (toDataURL), tanto via namespace
 * (location-labels-pdf) quanto via default import (danfe-nfce-pdf).
 */
declare module "qrcode" {
  export interface QRCodeToDataURLOptions {
    margin?: number;
    width?: number;
    scale?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    color?: { dark?: string; light?: string };
  }

  export function toDataURL(
    text: string,
    options?: QRCodeToDataURLOptions,
  ): Promise<string>;

  const qrcode: {
    toDataURL: typeof toDataURL;
  };
  export default qrcode;
}

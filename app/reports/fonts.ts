import path from "path";
import fs from "fs";
import { Font } from "@react-pdf/renderer";
import { FONT } from "./theme";

/**
 * Registra as fontes da marca SOMENTE no gerador de PDF (não toca a fonte global
 * Geist do app). Idempotente. Os TTFs (OFL) são versionados em app/reports/fonts.
 * O caminho é resolvido a partir do cwd (raiz do projeto, onde o servidor sobe).
 */
let registered = false;

function fontDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "app/reports/fonts"),
    path.resolve(__dirname, "fonts"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignora — tenta o próximo candidato
    }
  }
  return candidates[0];
}

export function registerReportFonts(): void {
  if (registered) return;
  const dir = fontDir();
  const f = (name: string) => path.join(dir, name);

  Font.register({
    family: FONT.display,
    fonts: [{ src: f("ArchivoBlack-Regular.ttf"), fontWeight: 400 }],
  });
  Font.register({
    family: FONT.sans,
    fonts: [
      { src: f("IBMPlexSans-Regular.ttf"), fontWeight: 400 },
      { src: f("IBMPlexSans-SemiBold.ttf"), fontWeight: 600 },
    ],
  });
  Font.register({
    family: FONT.mono,
    fonts: [
      { src: f("JetBrainsMono-Regular.ttf"), fontWeight: 400 },
      { src: f("JetBrainsMono-Bold.ttf"), fontWeight: 700 },
    ],
  });

  // Evita quebras de linha estranhas em palavras longas (SKUs, e-mails).
  Font.registerHyphenationCallback((word) => [word]);

  registered = true;
}

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { toWinAnsiSafeLine } from "./danfe-helpers";

/**
 * Carimbo "CANCELADA" no DANFE de uma NF-e/NFC-e cancelada.
 *
 * Por que existe: o DANFE de nota cancelada saía IDÊNTICO ao de nota válida. Em
 * 25/09/2026 a DLS mandou ao suporte o DANFE da NF-e 716 (cancelada às 10:07)
 * achando que era a devolução refeita (NF-e 717, correta) — e quase cancelou a 717.
 *
 * Como: pós-processamento do PDF JÁ PRONTO, na entrega (download e e-mail). Vale
 * igual para o DANFE re-renderizado do XML, para o PDF guardado na autorização
 * (inclusive o que veio da Focus), para os três layouts de NF-e e para o cupom
 * NFC-e de 80 mm — e os renderers não mudam: nota não cancelada nunca passa por
 * aqui e sai byte a byte como antes.
 *
 * Só ACRESCENTA desenho por cima de cada página (um content stream novo depois
 * do original); não altera nem remove nada do documento, nem os metadados. O
 * arquivo guardado em disco não é tocado — quem chama recebe bytes novos.
 */

export interface CancelamentoDanfe {
  /** Hora em que o cancelamento foi registrado (evento CANCELADA da auditoria). */
  em: Date | null;
  /** Protocolo do evento de cancelamento, quando o provedor devolveu. */
  protocolo: string | null;
}

export const TEXTO_SEM_VALOR_FISCAL = "Este documento não tem valor fiscal";
/**
 * Sem protocolo, o Dexo NÃO afirma que o documento perdeu o valor fiscal: o status
 * CANCELLED sozinho não prova o cancelamento na SEFAZ. Na Focus V1 qualquer HTTP 200
 * vira sucesso — inclusive `erro_cancelamento` (SEFAZ recusou; a nota segue
 * AUTORIZADA) — e o SEFAZ direto aceita 573 (duplicidade) sem nProt.
 */
export const TEXTOS_SEM_PROTOCOLO = [
  "Sem protocolo de cancelamento da SEFAZ",
  "Confira a situação pela chave de acesso",
] as const;

export function rotuloCancelada(modelo: string | number | null | undefined): string {
  return String(modelo ?? "").trim() === "65" ? "NFC-e CANCELADA" : "NF-e CANCELADA";
}

/** dd/mm/aaaa hh:mm no horário de Brasília (a coluna do Prisma guarda UTC). */
export function dataHoraBrasilia(d: Date | null | undefined): string | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const p = (t: Intl.DateTimeFormatPartTypes) => partes.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}/${p("month")}/${p("year")} ${p("hour")}:${p("minute")}`;
}

/**
 * Linhas da faixa, na ordem em que descem. Uma informação por linha (no cupom de
 * 80 mm uma linha só ficaria miúda demais). "Registrado" porque a hora é a do
 * evento CANCELADA do Dexo, não a do evento na SEFAZ. `destaque` = negrito.
 */
export function linhasDaFaixa(c: CancelamentoDanfe | null | undefined): Array<{ texto: string; destaque: boolean }> {
  const quando = dataHoraBrasilia(c?.em);
  const protocolo = toWinAnsiSafeLine(String(c?.protocolo ?? "")).slice(0, 60);
  return [
    ...(quando ? [{ texto: `Cancelamento registrado em ${quando}`, destaque: true }] : []),
    ...(protocolo
      ? [
          { texto: `Protocolo de cancelamento ${protocolo}`, destaque: true },
          { texto: TEXTO_SEM_VALOR_FISCAL, destaque: false },
        ]
      : TEXTOS_SEM_PROTOCOLO.map((texto) => ({ texto, destaque: false }))),
  ];
}

// ── Geometria (pura, testável sem PDF) ──

/** Altura das maiúsculas da Helvetica/Helvetica-Bold (AFM: CapHeight 718). */
const CAP_HELVETICA = 0.718;
/** Fração da diagonal que o rótulo ocupa. */
const FRACAO_DIAGONAL = 0.72;
/** Folga mínima entre o carimbo e a borda da página, em pontos. */
const MARGEM = 6;

export interface LinhaCarimbo {
  texto: string;
  tamanho: number;
  x: number;
  y: number;
}

export interface GeometriaCarimbo {
  anguloGraus: number;
  rotulo: LinhaCarimbo;
  faixa: { x: number; y: number; largura: number; altura: number; borda: number };
  linhas: LinhaCarimbo[];
  /** Meias-extensões do bloco inteiro, alinhadas aos eixos da página (para conferir que cabe). */
  meiaExtensao: { x: number; y: number };
}

/**
 * Onde desenhar: o rótulo grande ao longo da diagonal, centrado na página, e logo
 * abaixo dele (na perpendicular) uma faixa com as linhas de detalhe. Se o bloco
 * não couber na página (cupom estreito, página pequena), TUDO encolhe na mesma
 * proporção — nunca sai para fora.
 */
export function geometriaCarimbo(e: {
  origemX?: number;
  origemY?: number;
  largura: number;
  altura: number;
  /** Rótulo e sua largura desenhado em tamanho 1 (fonte negrito). */
  rotuloEm1: { texto: string; largura: number };
  /** Linhas de detalhe e suas larguras em tamanho 1. */
  linhasEm1: Array<{ texto: string; largura: number }>;
}): GeometriaCarimbo {
  const w = e.largura;
  const h = e.altura;
  const theta = Math.atan2(h, w);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const diag = Math.hypot(w, h);

  let tamRotulo = (FRACAO_DIAGONAL * diag) / Math.max(e.rotuloEm1.largura, 1e-6);
  const maiorLinhaEm1 = Math.max(0, ...e.linhasEm1.map((l) => l.largura));
  let tamLinha = Math.min(13, Math.max(7, tamRotulo * 0.15));
  if (maiorLinhaEm1 > 0) tamLinha = Math.min(tamLinha, (FRACAO_DIAGONAL * diag) / maiorLinhaEm1);

  let respiro = tamLinha * 0.6;
  let entreLinhas = tamLinha * 0.45;
  let vao = tamRotulo * 0.18;
  const n = e.linhasEm1.length;
  const medir = () => {
    const capRotulo = tamRotulo * CAP_HELVETICA;
    const larguraRotulo = e.rotuloEm1.largura * tamRotulo;
    const larguraFaixa = n ? maiorLinhaEm1 * tamLinha + 3 * respiro : 0;
    const alturaFaixa = n ? n * tamLinha + (n - 1) * entreLinhas + 2 * respiro : 0;
    const espessura = capRotulo + (n ? vao + alturaFaixa : 0);
    const meioComprimento = Math.max(larguraRotulo, larguraFaixa) / 2;
    return {
      capRotulo,
      larguraRotulo,
      larguraFaixa,
      alturaFaixa,
      espessura,
      ex: meioComprimento * cos + (espessura / 2) * sin,
      ey: meioComprimento * sin + (espessura / 2) * cos,
    };
  };
  let m = medir();
  const fator = Math.min(1, (w / 2 - MARGEM) / m.ex, (h / 2 - MARGEM) / m.ey);
  if (fator < 1) {
    const f = Math.max(fator, 0.01);
    tamRotulo *= f;
    tamLinha *= f;
    respiro *= f;
    entreLinhas *= f;
    vao *= f;
    m = medir();
  }

  const cx = (e.origemX ?? 0) + w / 2;
  const cy = (e.origemY ?? 0) + h / 2;
  // u = ao longo do texto; v = "para cima" do texto. Deslocamento positivo = para baixo.
  const u = { x: cos, y: sin };
  const v = { x: -sin, y: cos };
  const ponto = (desloc: number) => ({ x: cx - desloc * v.x, y: cy - desloc * v.y });
  /** Origem (linha de base, início) de um texto de largura `lw` cujo centro visual fica em `c`. */
  const origem = (c: { x: number; y: number }, lw: number, cap: number) => ({
    x: c.x - (lw / 2) * u.x - (cap / 2) * v.x,
    y: c.y - (lw / 2) * u.y - (cap / 2) * v.y,
  });

  const topo = -m.espessura / 2;
  const oRotulo = origem(ponto(topo + m.capRotulo / 2), m.larguraRotulo, m.capRotulo);

  const centroFaixa = ponto(topo + m.capRotulo + vao + m.alturaFaixa / 2);
  const cantoFaixa = {
    x: centroFaixa.x - (m.larguraFaixa / 2) * u.x - (m.alturaFaixa / 2) * v.x,
    y: centroFaixa.y - (m.larguraFaixa / 2) * u.y - (m.alturaFaixa / 2) * v.y,
  };

  const linhas: LinhaCarimbo[] = e.linhasEm1.map((l, i) => {
    const desloc = topo + m.capRotulo + vao + respiro + i * (tamLinha + entreLinhas) + tamLinha / 2;
    const o = origem(ponto(desloc), l.largura * tamLinha, tamLinha * CAP_HELVETICA);
    return { texto: l.texto, tamanho: tamLinha, x: o.x, y: o.y };
  });

  return {
    anguloGraus: (theta * 180) / Math.PI,
    rotulo: { texto: e.rotuloEm1.texto, tamanho: tamRotulo, x: oRotulo.x, y: oRotulo.y },
    faixa: {
      x: cantoFaixa.x,
      y: cantoFaixa.y,
      largura: m.larguraFaixa,
      altura: m.alturaFaixa,
      borda: Math.max(0.6, tamLinha * 0.08),
    },
    linhas,
    meiaExtensao: { x: m.ex, y: m.ey },
  };
}

// ── Página com /Rotate ──
// /Rotate gira a página no sentido HORÁRIO só na EXIBIÇÃO; o desenho continua no
// espaço do usuário, que não gira. Sem conversão, em /Rotate 180 o carimbo sai de
// cabeça para baixo na tela, e em 90/270, deitado. Os PDFs que a Dexo gera não têm
// /Rotate (todos saem do pdf-lib), mas um PDF de terceiros guardado pode ter.

export type RotacaoPagina = 0 | 90 | 180 | 270;

/** /Rotate reduzido a 0/90/180/270. Fora de múltiplo de 90 (inválido) vale 0, como no pdf.js. */
export function normalizarRotacao(graus: number): RotacaoPagina {
  if (!Number.isFinite(graus) || graus % 90 !== 0) return 0;
  return ((((graus % 360) + 360) % 360) || 0) as RotacaoPagina;
}

export interface CaixaPagina {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Leva um ponto do espaço VISUAL (a página como aparece na tela, já girada: origem
 * no canto inferior esquerdo, x para a direita, y para cima) para o espaço do
 * usuário, onde se desenha. `caixa` é o CropBox no espaço do usuário. Uma direção
 * de α graus na tela vira α + rotação graus no espaço do usuário.
 */
export function visualParaUsuario(
  p: { x: number; y: number },
  caixa: CaixaPagina,
  rotacao: RotacaoPagina,
): { x: number; y: number } {
  switch (rotacao) {
    case 90:
      return { x: caixa.x + caixa.width - p.y, y: caixa.y + p.x };
    case 180:
      return { x: caixa.x + caixa.width - p.x, y: caixa.y + caixa.height - p.y };
    case 270:
      return { x: caixa.x + p.y, y: caixa.y + caixa.height - p.x };
    default:
      return { x: caixa.x + p.x, y: caixa.y + p.y };
  }
}

/**
 * Geometria do carimbo no espaço do usuário de uma página com CropBox `caixa` e
 * /Rotate `rotacao`. Sem rotação é `geometriaCarimbo` sobre o CropBox, exatamente
 * como antes (o caso de todo PDF que a Dexo gera). Com rotação, o carimbo é montado
 * na página COMO APARECE NA TELA (largura e altura trocadas em 90/270) e cada ponto
 * e o ângulo são levados ao espaço do usuário: na tela, o rótulo sobe da
 * esquerda-baixo para a direita-cima e a faixa fica legível, como sem rotação.
 */
export function geometriaCarimboNaPagina(e: {
  caixa: CaixaPagina;
  rotacao: RotacaoPagina;
  rotuloEm1: { texto: string; largura: number };
  linhasEm1: Array<{ texto: string; largura: number }>;
}): GeometriaCarimbo {
  const { caixa, rotacao, rotuloEm1, linhasEm1 } = e;
  if (rotacao === 0) {
    return geometriaCarimbo({
      origemX: caixa.x,
      origemY: caixa.y,
      largura: caixa.width,
      altura: caixa.height,
      rotuloEm1,
      linhasEm1,
    });
  }
  const deitada = rotacao === 90 || rotacao === 270;
  const g = geometriaCarimbo({
    largura: deitada ? caixa.height : caixa.width,
    altura: deitada ? caixa.width : caixa.height,
    rotuloEm1,
    linhasEm1,
  });
  const leva = (p: { x: number; y: number }) => visualParaUsuario(p, caixa, rotacao);
  return {
    anguloGraus: g.anguloGraus + rotacao,
    rotulo: { ...g.rotulo, ...leva(g.rotulo) },
    faixa: { ...g.faixa, ...leva(g.faixa) },
    linhas: g.linhas.map((l) => ({ ...l, ...leva(l) })),
    meiaExtensao: deitada ? { x: g.meiaExtensao.y, y: g.meiaExtensao.x } : g.meiaExtensao,
  };
}

/** /Rotate da página (herdado inclusive). Valor que o pdf-lib não lê = sem rotação, como antes. */
function rotacaoDaPagina(pagina: PDFPage): RotacaoPagina {
  try {
    return normalizarRotacao(pagina.getRotation().angle);
  } catch {
    return 0;
  }
}

// ── Desenho ──

const VERMELHO = rgb(0.78, 0.05, 0.05);
const BRANCO = rgb(1, 1, 1);

function carimbarPagina(
  pagina: PDFPage,
  negrito: PDFFont,
  rotulo: string,
  linhas: Array<{ texto: string; fonte: PDFFont }>,
): void {
  const g = geometriaCarimboNaPagina({
    caixa: pagina.getCropBox(),
    rotacao: rotacaoDaPagina(pagina),
    rotuloEm1: { texto: rotulo, largura: negrito.widthOfTextAtSize(rotulo, 1) },
    linhasEm1: linhas.map((l) => ({ texto: l.texto, largura: l.fonte.widthOfTextAtSize(l.texto, 1) })),
  });
  const rotate = degrees(g.anguloGraus);
  pagina.drawText(g.rotulo.texto, {
    x: g.rotulo.x,
    y: g.rotulo.y,
    size: g.rotulo.tamanho,
    font: negrito,
    color: VERMELHO,
    opacity: 0.3,
    rotate,
  });
  if (!linhas.length) return;
  pagina.drawRectangle({
    x: g.faixa.x,
    y: g.faixa.y,
    width: g.faixa.largura,
    height: g.faixa.altura,
    rotate,
    color: BRANCO,
    opacity: 0.88,
    borderColor: VERMELHO,
    borderWidth: g.faixa.borda,
    borderOpacity: 1,
  });
  g.linhas.forEach((l, i) =>
    pagina.drawText(l.texto, {
      x: l.x,
      y: l.y,
      size: l.tamanho,
      font: linhas[i].fonte,
      color: VERMELHO,
      rotate,
    }),
  );
}

/**
 * Devolve o PDF com "NF-e CANCELADA" (ou "NFC-e CANCELADA") em diagonal em TODAS
 * as páginas, mais uma faixa com a data e o protocolo do cancelamento e, só quando há
 * protocolo, "Este documento não tem valor fiscal" (sem ele, pede para conferir na
 * SEFAZ — ver TEXTOS_SEM_PROTOCOLO). Lança se o PDF não puder ser lido —
 * quem chama decide o que fazer; entregar a nota cancelada SEM a marca é
 * exatamente o defeito que isto corrige.
 */
export async function carimbarDanfeCancelada(
  pdf: Uint8Array,
  opcoes: { modelo?: string | number | null; cancelamento?: CancelamentoDanfe | null } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const paginas = doc.getPages();
  if (paginas.length === 0) throw new Error("PDF do DANFE sem páginas");
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const rotulo = toWinAnsiSafeLine(rotuloCancelada(opcoes.modelo));
  const linhas = linhasDaFaixa(opcoes.cancelamento).map((l) => ({
    texto: toWinAnsiSafeLine(l.texto),
    fonte: l.destaque ? negrito : regular,
  }));
  for (const pagina of paginas) carimbarPagina(pagina, negrito, rotulo, linhas);
  return doc.save();
}

// Como cada fonte vira UMA linha do card — a parte pura.
//
// Está fora do .tsx de propósito: a suíte roda com `environment: "node"`, sem
// jsdom, e esta é a única lógica de verdade do componente. Separada, ela é
// testada de graça; dentro do React, seria testada por leitura de texto-fonte.
//
// Fonte de tipo desconhecido vira `null` e é ignorada em silêncio: servidor
// novo com front antigo não pode quebrar a tela de ninguém.

/** O shape que chega do servidor. Tudo opcional: o front não confia, valida. */
export interface BitzSource {
  kind?: string;
  // conhecimento
  docId?: string;
  docTitle?: string;
  heading?: string;
  // proprio
  label?: string;
  count?: number;
  // plataforma
  sampleSize?: number;
  confidence?: string;
  matchKey?: string;
  // regra
  rule?: string;
  // externa
  provider?: string;
  ref?: string;
  // estimativa
  note?: string;
}

export type IconeDaFonte =
  "livro" | "caixa" | "grafico" | "balanca" | "globo" | "faisca";

export interface LinhaDeFonte {
  /** Chave de dedupe e de render. */
  chave: string;
  texto: string;
  icone: IconeDaFonte;
  /**
   * Destaque visual. Só a `estimativa` tem, e é a mais importante do conjunto:
   * significa "isto o Bitz escreveu, não consultou". Num card em que todas as
   * linhas parecem iguais, essa distinção some.
   */
  destaque?: boolean;
}

const CONFIANCA: Record<string, string> = {
  alta: "alta",
  media: "média",
  baixa: "baixa",
};

export function paraLinha(
  s: BitzSource | null | undefined,
): LinhaDeFonte | null {
  if (!s) return null;
  switch (s.kind) {
    case "conhecimento":
      if (!s.docTitle) return null;
      return {
        // Cinco pedaços do mesmo documento viram UMA linha: o usuário quer
        // saber de onde veio, não em qual parágrafo.
        chave: `conhecimento:${s.docTitle}`,
        texto: s.heading ? `${s.docTitle} — ${s.heading}` : s.docTitle,
        icone: "livro",
      };
    case "proprio":
      if (!s.label) return null;
      return {
        chave: `proprio:${s.label}`,
        texto:
          typeof s.count === "number" && s.count > 0
            ? `${s.label} (${s.count})`
            : s.label,
        icone: "caixa",
      };
    case "plataforma":
      if (typeof s.sampleSize !== "number") return null;
      return {
        chave: `plataforma:${s.matchKey ?? ""}`,
        texto: `Base consolidada do Dexo — ${s.sampleSize} peças parecidas, confiança ${
          CONFIANCA[s.confidence ?? ""] ?? "—"
        }`,
        icone: "grafico",
      };
    case "regra":
      if (!s.rule) return null;
      return { chave: `regra:${s.rule}`, texto: s.rule, icone: "balanca" };
    case "externa":
      // Um provedor só, e literal. Fonte externa nova é decisão de produto.
      if (s.provider !== "mercado-livre") return null;
      return {
        chave: `externa:${s.ref ?? ""}`,
        texto: s.ref
          ? `Catálogo público do Mercado Livre — ${s.ref}`
          : "Catálogo público do Mercado Livre",
        icone: "globo",
      };
    case "estimativa":
      if (!s.note) return null;
      return {
        chave: "estimativa",
        texto: s.note,
        icone: "faisca",
        destaque: true,
      };
    default:
      return null;
  }
}

/** As linhas do card, já sem repetição e na ordem em que o servidor mandou. */
export function linhasDoCard(sources?: unknown[]): LinhaDeFonte[] {
  const vistos = new Set<string>();
  const saida: LinhaDeFonte[] = [];
  for (const s of (sources ?? []) as BitzSource[]) {
    const linha = paraLinha(s);
    if (!linha || vistos.has(linha.chave)) continue;
    vistos.add(linha.chave);
    saida.push(linha);
  }
  return saida;
}

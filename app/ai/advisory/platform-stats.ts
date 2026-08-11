// Fonte 2 da cadeia: a base consolidada da plataforma (CatalogStat).
//
// É o agregado de peças vivas de TODAS as lojas do Dexo, recalculado por um job
// noturno. O que se lê daqui é mediana, moda, união e contagem — nunca a linha
// de ninguém.
//
// ⭐ PRIVACIDADE — as três travas, e por que são três:
//
//  1. A TABELA. `CatalogStat` não tem `userId`, não tem nome de loja, não tem
//     `costPrice` nem `markup` (schema.prisma:301 e o cabeçalho do model dizem
//     isso em voz alta). Não existe coluna para vazar.
//
//  2. O JOB. `catalog-stats-aggregation.ts:316` só persiste família com
//     `memberCount >= MIN_SAMPLE`. O limiar de 5 não é estatística: é para uma
//     família de uma loja só não virar uma janela para o preço daquela loja.
//
//  3. ESTE ARQUIVO. Rechecamos `sampleSize >= MIN_SAMPLE` na leitura, mesmo
//     sabendo do passo 2. Se um dia alguém baixar o limiar do job — ou rodar um
//     backfill sem ele — o Bitz continua se recusando a sugerir. O gate de
//     privacidade fica do lado de quem exporta o dado, não de quem o produz.
//
// A leitura é `InternalSuggestionUseCase.suggestFromTitle`, o MESMO caminho do
// botão "sugerir" do cadastro de produto. Cascata de 3 níveis por versão/ano,
// cache de 120 s, nunca toca `Product`.

import { MIN_SAMPLE } from "../../marketplaces/lib/catalog-stats-aggregation";
import { InternalSuggestionUseCase } from "../../marketplaces/usecases/internal-suggestion.usecase";
import type { AiSource } from "../core/types";
import { money, num, texto } from "../tools/serialize";

export { MIN_SAMPLE };

export type Confianca = "alta" | "media" | "baixa";

export interface AgregadoDaPlataforma {
  matchKey: string;
  sampleSize: number;
  confidence: Confianca;
  precoMediana: number | null;
  pesoKg: number | null;
  alturaCm: number | null;
  larguraCm: number | null;
  comprimentoCm: number | null;
  categoriaMlId: string | null;
  categoriaShopeeId: string | null;
  qualidade: string | null;
  versao: string | null;
  partNumber: string | null;
  compatibilidades: Array<{
    marca: string;
    modelo: string;
    anoDe: number | null;
    anoAte: number | null;
    versao: string | null;
  }>;
}

/**
 * Lê a base consolidada para um título.
 *
 * Devolve `null` quando não há família, quando a amostra é insuficiente ou
 * quando o título não tem entidades suficientes (tipo de peça + marca +
 * modelo). Em todos esses casos a resposta certa é passar para o próximo
 * degrau, nunca inventar.
 */
export async function lerAgregadoDaPlataforma(
  titulo: string,
): Promise<AgregadoDaPlataforma | null> {
  const consulta = (titulo ?? "").trim();
  if (!consulta) return null;

  const resultado = await InternalSuggestionUseCase.suggestFromTitle(consulta);
  const sugestao = resultado.suggestion;
  if (!sugestao) return null;

  // Trava 3. `sampleSize` menor que o mínimo não sugere — nem com "confiança
  // baixa", nem com ressalva. Simplesmente não responde.
  const sampleSize = Number(sugestao.sampleSize ?? 0);
  if (!Number.isFinite(sampleSize) || sampleSize < MIN_SAMPLE) return null;

  const f = sugestao.fields ?? {};

  return {
    matchKey: texto(sugestao.matchKey, 80) ?? "",
    sampleSize,
    confidence: (sugestao.confidence ?? "baixa") as Confianca,
    precoMediana: money(f.priceMedian),
    pesoKg: num(f.weightKg),
    alturaCm: num(f.heightCm),
    larguraCm: num(f.widthCm),
    comprimentoCm: num(f.lengthCm),
    categoriaMlId: f.mlCategoryId ?? null,
    categoriaShopeeId: f.shopeeCategoryId ?? null,
    qualidade: f.quality ?? null,
    versao: f.version ?? null,
    partNumber: f.partNumber ?? null,
    compatibilidades: (sugestao.compatibilities ?? []).map((c) => ({
      marca: String(c.brand),
      modelo: String(c.model),
      anoDe: c.yearFrom ?? null,
      anoAte: c.yearTo ?? null,
      versao: c.version ?? null,
    })),
  };
}

/** A procedência que o usuário vê quando a resposta veio da base consolidada. */
export function fonteDaPlataforma(a: AgregadoDaPlataforma): AiSource {
  return {
    kind: "plataforma",
    sampleSize: a.sampleSize,
    confidence: a.confidence,
    matchKey: a.matchKey,
  };
}

/**
 * O que o modelo precisa REPASSAR sobre um número da base consolidada.
 *
 * Sem isto, "o peso é 4,2 kg" vira uma afirmação sobre a peça do lojista,
 * quando é a mediana de outras lojas para uma família parecida. A diferença
 * importa: com peso errado o anúncio sai com frete errado.
 */
export function comoLerAgregado(a: AgregadoDaPlataforma): string {
  return (
    `Estes números são a MEDIANA de ${a.sampleSize} peças parecidas cadastradas na plataforma ` +
    `(família "${a.matchKey}", confiança ${a.confidence}) — não são medições desta peça. ` +
    `São ponto de partida: quem confere é o lojista.`
  );
}

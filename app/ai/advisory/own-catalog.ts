// Fonte 1 da cadeia: o catálogo do PRÓPRIO cliente.
//
// É a fonte mais forte e a mais barata, nessa ordem de importância. Se esta
// loja já cadastrou seis "Farol Palio", o preço que ELA pratica, a categoria
// que ELA escolheu e as medidas que ELA mediu valem mais do que qualquer média
// de mercado — e responder com isso não manda o título para lugar nenhum.
//
// ⚠️ MESMO EFEITO COLATERAL DA FASE 5, e é deliberado:
// `ProductUseCase.listProducts` com `search` chama `ensureTextSearchExtensions`
// (product.repository.ts:1348 → :365), que roda `CREATE EXTENSION IF NOT
// EXISTS pg_trgm` e alguns `CREATE INDEX` uma vez por processo. É exatamente o
// que a tela de Produtos já faz quando alguém digita na busca. A alternativa
// seria escrever uma segunda busca "limpa", que divergiria da tela — e o
// critério desta entrega é que o número do Bitz seja o número da tela.

import { titleSimilarity } from "../../lib/title-similarity";
import { ProductUseCase } from "../../usecases/product.usercase";
import type { AiScope } from "../core/scope";
import { money, num, texto } from "../tools/serialize";

/**
 * Piso de similaridade para considerar duas peças "a mesma coisa".
 *
 * É o MESMO limiar que o sistema usa para decidir se dois anúncios sob um SKU
 * de caixa reaproveitado são o mesmo produto ou produtos diferentes
 * (title-similarity.ts). Reusar em vez de inventar um número novo mantém uma
 * régua só de "peça parecida" no sistema inteiro.
 */
export const LIMIAR_SIMILARIDADE = 0.4;

/**
 * Quantas peças próprias são necessárias para virar referência.
 *
 * Uma peça é uma anedota — pode ser a que ficou com preço errado. Três já é um
 * padrão da loja. Não é o limiar de privacidade da base consolidada (esse é 5,
 * e existe para não expor um concorrente único): aqui o dado é do próprio dono,
 * o critério é só honestidade estatística.
 */
export const MIN_AMOSTRA_PROPRIA = 3;

/** Quantas peças buscar antes de filtrar por similaridade. */
const CANDIDATAS = 20;

export interface PecaParecida {
  id: string;
  sku: string;
  nome: string;
  preco: number | null;
  marca: string | null;
  modelo: string | null;
  ano: string | null;
  versao: string | null;
  qualidade: string | null;
  descricao: string | null;
  alturaCm: number | null;
  larguraCm: number | null;
  comprimentoCm: number | null;
  pesoKg: number | null;
  categoriaMlId: string | null;
  categoriaMlCaminho: string | null;
  categoriaShopeeId: string | null;
  similaridade: number;
}

/**
 * Peças do próprio catálogo parecidas com o título.
 *
 * ⭐ Projeção por ALLOWLIST literal. `listProducts` devolve o produto inteiro,
 * `costPrice` e `markup` inclusive (product.repository.ts:429-430). Nada aqui
 * repassa o objeto do usecase adiante: o que sai é este registro e só ele.
 */
export async function buscarPecasParecidas(
  scope: AiScope,
  titulo: string,
  opts?: { limiar?: number },
): Promise<PecaParecida[]> {
  const consulta = (titulo ?? "").trim();
  if (!consulta) return [];

  const limiar = opts?.limiar ?? LIMIAR_SIMILARIDADE;
  const usecase = new ProductUseCase();

  const { products } = await usecase.listProducts({
    userId: scope.dataOwnerId,
    search: consulta,
    limit: CANDIDATAS,
    page: 1,
  });

  const saida: PecaParecida[] = [];
  for (const p of products as any[]) {
    const similaridade = titleSimilarity(consulta, String(p.name ?? ""));
    if (similaridade < limiar) continue;
    saida.push({
      id: String(p.id),
      sku: String(p.sku ?? ""),
      nome: String(p.name ?? ""),
      preco: money(p.price),
      marca: p.brand ?? null,
      modelo: p.model ?? null,
      ano: p.year ?? null,
      versao: p.version ?? null,
      qualidade: p.quality ?? null,
      descricao: texto(p.description, 400),
      alturaCm: num(p.heightCm),
      larguraCm: num(p.widthCm),
      comprimentoCm: num(p.lengthCm),
      pesoKg: num(p.weightKg),
      categoriaMlId: p.mlCategory?.externalId ?? null,
      categoriaMlCaminho: p.mlCategory?.fullPath ?? null,
      categoriaShopeeId: p.shopeeCategoryId ?? null,
      similaridade: Math.round(similaridade * 100) / 100,
    });
  }

  // Mais parecida primeiro; empate pelo SKU, para dois turnos iguais darem a
  // mesma resposta.
  saida.sort(
    (a, b) => b.similaridade - a.similaridade || a.sku.localeCompare(b.sku),
  );
  return saida;
}

/** Mediana de uma lista de números. Ignora nulo. `null` se não sobrar nada. */
export function mediana(
  valores: Array<number | null | undefined>,
): number | null {
  const nums = valores
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const meio = Math.floor(nums.length / 2);
  const bruta =
    nums.length % 2 === 1 ? nums[meio] : (nums[meio - 1] + nums[meio]) / 2;
  return Math.round(bruta * 100) / 100;
}

/** Moda (valor mais frequente). Empate resolvido pelo primeiro a aparecer. */
export function moda<T extends string>(
  valores: Array<T | null | undefined>,
): T | null {
  const contagem = new Map<T, number>();
  for (const v of valores) {
    if (v === null || v === undefined || v === ("" as T)) continue;
    contagem.set(v, (contagem.get(v) ?? 0) + 1);
  }
  let melhor: T | null = null;
  let maior = 0;
  for (const [valor, n] of contagem) {
    if (n > maior) {
      melhor = valor;
      maior = n;
    }
  }
  return melhor;
}

/**
 * Casamento por ETIQUETA — a segunda chance do vínculo por SKU.
 *
 * POR QUE ISTO EXISTE
 *
 * O vínculo casa a linha da planilha com o produto do Dexo por `Cod Peça`.
 * Existe um caso real, medido, em que essa chave não casa NADA: o cliente já
 * tinha o catálogo no Dexo (24.415 produtos vindos da importação de anúncios,
 * **nenhum com localização**) e a planilha do Vaapt trazia justamente as
 * localizações. Só que o SKU no Dexo veio do anúncio, não do Vaapt:
 *
 *     Dexo ....... "18593"   ou   "15709 N535"   (etiqueta + prateleira)
 *     Cod Peça ... 5340416                        → casa com ZERO produtos
 *     Etiqueta ... 18593                          → casa
 *
 * Medido nos dois arquivos reais, contra os 24.423 produtos do tenant:
 *
 *     por SKU exato (único) .............. 13.305
 *     só pelo 1º token do SKU (único) .... +2.589
 *     ambíguos (2+ produtos) ................. 29   ← NUNCA vincula
 *     ------------------------------------------------
 *     vinculáveis com segurança .......... 15.894 de 28.875 (55,0%)
 *
 * COMO FUNCIONA
 *
 * É um passo PRÉVIO que só reescreve `item.sku` — `matchItemsBySku` e
 * `executeLinksPlan` continuam byte-idênticos. Foi de propósito: aquele helper
 * é compartilhado com a importação de FOTOS e com o WebDesmonte, e mexer nele
 * arriscaria dois fluxos que já funcionam.
 *
 * A `Etiqueta` só é usada quando o `Cod Peça` NÃO achou produto — nunca por
 * cima de um casamento que já deu certo.
 *
 * ⚠️ REGRA DE OURO: só vincula quando a chave aponta para EXATAMENTE UM
 * produto. Duas chaves candidatas, nesta ordem:
 *   1. SKU inteiro igual à etiqueta;
 *   2. PRIMEIRO TOKEN do SKU igual à etiqueta (é o formato "18593 N535").
 * O 1º token colide em 4.140 dos 24.423 produtos do tenant medido, então o
 * teste de unicidade não é decorativo: é ele que impede o vínculo errado.
 */

import { normalizeSku } from "../../../lib/sku";
import type { ImportContext, ImportReport } from "../import.types";
import { MAX_EXAMPLES, addIssue, bump } from "../import.types";
import type { LinkPlanItem } from "../mappers/vinculos.mapper";

/** Produto do tenant, no mínimo necessário para indexar e reescrever o SKU. */
export interface ProdutoParaEtiqueta {
  id: string;
  sku: string;
  skuNormalized: string | null;
}

export interface EtiquetaMatchDeps {
  /**
   * TODOS os produtos do tenant, numa consulta só.
   *
   * Um `IN` sobre `skuNormalized` resolveria o casamento exato, mas não o do
   * primeiro token: o índice guarda `"15709 n535"` inteiro, e a etiqueta é
   * `"15709"` — não há como pedir isso ao banco sem varredura. Então: UMA
   * consulta com select mínimo em vez de 58 lotes de `IN` mais uma varredura.
   * Medido no tenant real: 24.423 linhas de 3 campos.
   */
  loadTodosOsProdutos: (userId: string) => Promise<ProdutoParaEtiqueta[]>;
}

/** Chave normalizada — mesma normalização do SKU (trim + lowercase). */
function chave(valor: string | null | undefined): string | null {
  return normalizeSku(typeof valor === "string" ? valor : null);
}

/** 1º token do SKU: "15709 N535" → "15709". Null quando não há espaço. */
function primeiroToken(sku: string): string | null {
  const t = sku.trim().split(/\s+/)[0];
  if (!t || t.length === sku.trim().length) return null; // sem espaço: já é o exato
  return normalizeSku(t);
}

export interface EtiquetaMatchResult {
  /** Itens com `sku` já reescrito para o SKU real do produto casado. */
  items: LinkPlanItem[];
  /** Quantos passaram a casar graças à etiqueta. */
  resolvidos: number;
  /** Etiquetas que apontaram para 2+ produtos (não vinculadas). */
  ambiguos: number;
}

/**
 * Reescreve o `sku` dos itens cujo `Cod Peça` não existe no Dexo mas cuja
 * `Etiqueta` identifica um produto sem ambiguidade. Devolve a lista completa
 * (os itens intocados vêm junto, na mesma ordem).
 *
 * Não faz nada — nem consulta o banco — quando nenhum item tem etiqueta.
 */
export async function resolverPorEtiqueta(
  ctx: ImportContext,
  report: ImportReport,
  items: LinkPlanItem[],
  deps: EtiquetaMatchDeps,
): Promise<EtiquetaMatchResult> {
  const comEtiqueta = items.filter((i) => chave(i.etiqueta) !== null);
  if (comEtiqueta.length === 0) {
    return { items, resolvidos: 0, ambiguos: 0 };
  }

  const produtos = await deps.loadTodosOsProdutos(ctx.targetUserId);
  if (produtos.length === 0) {
    return { items, resolvidos: 0, ambiguos: 0 };
  }

  // Dois índices: SKU inteiro e 1º token. Guardam LISTA porque a unicidade é
  // o que decide se pode vincular.
  const porSkuInteiro = new Map<string, ProdutoParaEtiqueta[]>();
  const porToken = new Map<string, ProdutoParaEtiqueta[]>();
  for (const p of produtos) {
    const inteiro = p.skuNormalized ?? normalizeSku(p.sku);
    if (inteiro) {
      const arr = porSkuInteiro.get(inteiro) ?? [];
      arr.push(p);
      porSkuInteiro.set(inteiro, arr);
    }
    const tok = primeiroToken(String(p.sku));
    if (tok) {
      const arr = porToken.get(tok) ?? [];
      arr.push(p);
      porToken.set(tok, arr);
    }
  }

  // Os `Cod Peça` que JÁ casam continuam mandando: a etiqueta é segunda chance,
  // nunca substituição.
  const jaCasaPorCodPeca = new Set<string>();
  for (const item of items) {
    const k = chave(item.sku);
    if (k && porSkuInteiro.has(k)) jaCasaPorCodPeca.add(k);
  }

  let resolvidos = 0;
  let ambiguos = 0;
  const exemplos: string[] = [];
  const saida: LinkPlanItem[] = [];

  for (const item of items) {
    const kSku = chave(item.sku);
    if (kSku && jaCasaPorCodPeca.has(kSku)) {
      saida.push(item);
      continue;
    }
    const kEtq = chave(item.etiqueta);
    if (!kEtq) {
      saida.push(item);
      continue;
    }

    // 1ª candidata: SKU inteiro. 2ª: primeiro token.
    const candidatos = porSkuInteiro.get(kEtq) ?? porToken.get(kEtq) ?? [];
    if (candidatos.length === 0) {
      saida.push(item);
      continue;
    }
    if (candidatos.length > 1) {
      ambiguos++;
      if (exemplos.length < MAX_EXAMPLES) {
        exemplos.push(
          `etiqueta "${item.etiqueta}" aponta para ${candidatos.length} produtos`,
        );
      }
      saida.push(item); // segue com o SKU original → cai em `sem_produto`
      continue;
    }

    resolvidos++;
    saida.push({ ...item, sku: candidatos[0].sku });
  }

  if (resolvidos > 0) {
    bump(report, "casados_pela_etiqueta", resolvidos);
    bump(report, "avisos");
    addIssue(report.avisos, {
      motivo:
        `${resolvidos} peça(s) foram encontradas pela ETIQUETA, e não pelo "Cod Peça" — ` +
        `é o caso de quem já tinha os produtos no Dexo com a numeração do anúncio. ` +
        `Só vinculamos quando a etiqueta identifica um único produto.`,
    });
  }
  if (ambiguos > 0) {
    bump(report, "etiqueta_ambigua", ambiguos);
    bump(report, "avisos");
    addIssue(report.avisos, {
      motivo:
        `${ambiguos} etiqueta(s) apontam para mais de um produto no Dexo e por isso ` +
        `NÃO foram vinculadas: ${exemplos.slice(0, 5).join("; ")}.`,
    });
  }

  return { items: saida, resolvidos, ambiguos };
}

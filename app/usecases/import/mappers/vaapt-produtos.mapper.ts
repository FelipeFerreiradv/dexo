/**
 * Relatório de produtos do Vaapt — o export NOVO ("Relatório de Produtos
 * Cadastrados"). Cada linha é um produto completo: SKU, nome, preço,
 * quantidade, descrição e a localização em texto plano.
 *
 * É DIFERENTE do arquivo-ponte (`VAAPT_PECAS`), que só traz SKU → localização
 * → veículo. Este aqui tem catálogo, então alimenta a entidade PRODUTOS, que
 * CRIA os produtos faltantes — o vínculo por SKU só liga o que já existe.
 *
 * Cabeçalho medido no export real (o rótulo vem DESLOCADO: a 1ª linha do sheet
 * é o título "Relatório de Produtos Cadastrados - Parte N" e os rótulos estão
 * na 1ª linha de dados; `readXlsxBuffer` já desfaz esse deslocamento):
 *
 *   Cod Peça | Nome Produto | Etiqueta | Preço | Cód Status | Condição |
 *   Qualidade | Un Medida | Qtd Inicial | Qtd Disponivel | Qtd Vendida |
 *   Descrição Produto | Localização Produto | Categoria ML | Mercado Livre |
 *   Status Mercado Livre | Config. Envio | Placa Veículo | Código Veículo |
 *   Apelido Veículo | Chassi | RENAVAM | Tipo Anúncio
 *
 * DECISÕES, todas medidas contra o arquivo real de 28.910 peças:
 *
 * - **Estoque = "Qtd Disponivel"**, não "Qtd Inicial". Inicial é histórico; o
 *   que o Dexo precisa saber é o que está na prateleira hoje.
 * - **"Cód Status" = "Excluido" pula a linha.** São peças apagadas na origem;
 *   criá-las no Dexo seria importar lixo.
 * - ⚠️ **"Qtd Disponivel" MENTE quando o status diz o contrário.** Esta é a
 *   correção de um erro meu: eu havia documentado que "a quantidade disponível
 *   já reflete a venda". **É falso**, e a medição nos dois arquivos reais
 *   mostra o tamanho do estrago:
 *
 *       Vendido .......................... 15.037 linhas, 10.782 com Qtd > 0
 *       Cadastro completo - não estocado .. 1.216 linhas,  1.216 com Qtd > 0
 *
 *   Seriam **12.009 produtos (41,5% do arquivo) nascendo com estoque fantasma**
 *   numa plataforma que publica em marketplace — ou seja, anúncio de peça que
 *   não existe. Por isso o estoque é **zerado** quando o status é "Vendido" ou
 *   contém "não estocado". A peça continua entrando (preço, descrição e
 *   histórico se preservam); o que não entra é a mentira sobre disponibilidade.
 * - **As colunas de veículo são ignoradas.** No export medido, "Placa
 *   Veículo", "Apelido Veículo", "Chassi" e "RENAVAM" são o literal "DUMMY" em
 *   100% das linhas e "Código Veículo" tem UM valor distinto. Não há sucata
 *   para criar, e foi justamente essa coluna que fez o detector classificar o
 *   arquivo como relatório de veículos.
 * - **"Etiqueta" e "Categoria ML" vão para `attributes`**, não viram anúncio
 *   nem categoria resolvida. Importar é povoar o catálogo; publicar é outro
 *   ato, explícito — mesma fronteira que `setImageUrlsMany` respeita.
 * - ⚠️ **"Etiqueta" NÃO é o MLB.** Medido: 27.058 valores são número puro,
 *   1.596 têm formato MLB e 255 são texto solto (inclusive "EXCLUIDO" e
 *   localizações digitadas no campo errado). É a etiqueta física da peça no
 *   Vaapt. Guardar isso num atributo chamado `mlb` faria 27.058 produtos
 *   mentirem para qualquer relatório futuro — por isso o nome é `vaaptEtiqueta`.
 * - **"Condição" vira `quality`**: "Novo" → NOVO (530 peças nos arquivos
 *   reais), o resto → SEMINOVO. Cravar SEMINOVO em tudo classificaria peça
 *   nova errado, e `quality` alimenta filtro de estoque e condição do anúncio.
 * - **Localização plana** (`normalizeCodeFlat`), igual a
 *   `mapVaaptLocations`/`scripts/migracao-vaapt.ts`. "S1 P1 N1 CX1" vira
 *   "S1P1N1CX1", um nó só. Quebrar em árvore S1→P1→N1→CX1 criaria uma árvore
 *   PARALELA num tenant já migrado pelo script, destruindo a idempotência.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import { normalizeCodeFlat } from "../lib/codes";
import { asNumber, asString, normName } from "../lib/normalize";
import { aliasReader } from "../lib/columns";
import type { LocationPlanItem } from "../executors/locations.executor";

export interface VaaptProdutoPlanItem {
  linha: number;
  sku: string;
  name: string;
  price: number;
  /** Já zerado quando o status diz que a peça não está disponível. */
  stock: number;
  /** "NOVO" quando a coluna Condição diz Novo; senão "SEMINOVO". */
  quality: "NOVO" | "SEMINOVO";
  /** Status cru da origem — vai para attributes, para auditoria. */
  status: string | null;
  /** Quantidade vendida na origem — auditoria do estoque depois do import. */
  qtdVendida: number | null;
  description: string | null;
  /** Código normalizado da localização; null se a linha não tem. */
  locationCode: string | null;
  /** Texto original (vira `Product.location` e a descrição da Location). */
  locationText: string | null;
  /** Etiqueta física da peça no Vaapt (NÃO é o MLB) — só auditoria. */
  etiqueta: string | null;
  /** Categoria ML da origem (ex.: "MLB101763") — só auditoria. */
  mlCategoriaExterna: string | null;
}

export interface VaaptProdutosMapResult {
  produtos: VaaptProdutoPlanItem[];
  /** Localizações distintas (planas, sem pai). */
  locationItems: LocationPlanItem[];
  totalRows: number;
  /** Linhas sem "Cod Peça". */
  semSku: number;
  /** Linhas cujo SKU repete outro do MESMO arquivo (1ª vence). */
  duplicadosSku: number;
  /** Linhas com "Cód Status" = Excluido. */
  excluidos: number;
  /** Linhas sem localização preenchida (não é erro). */
  semLocalizacao: number;
  /** Linhas cujo estoque foi ZERADO por causa do status (vendida/não estocada). */
  estoqueZeradoPorStatus: number;
  avisos: ImportRowIssue[];
}

/** Estoque: inteiro ≥ 0 (negativo/inválido → 0). */
function asStock(v: unknown): number {
  const n = asNumber(v);
  if (n === null) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * O status diz que a peça NÃO está disponível? Cobre "Vendido" e qualquer
 * variante de "não estocado" (com e sem acento — normName remove acento).
 */
export function statusIndisponivel(status: string | null): boolean {
  if (!status) return false;
  const n = normName(status);
  return n === "VENDIDO" || n.includes("NAO ESTOCADO");
}

export function mapVaaptProdutos(file: DetectedFile): VaaptProdutosMapResult {
  const produtos: VaaptProdutoPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const byCode = new Map<string, LocationPlanItem>();
  const seenSku = new Set<string>();
  let semSku = 0;
  let duplicadosSku = 0;
  let excluidos = 0;
  let semLocalizacao = 0;
  let estoqueZeradoPorStatus = 0;

  // Sinônimos resolvidos pelo HEADER: absorvem variação entre exports sem
  // duplicar o mapper. O 1º rótulo PRESENTE vence.
  const read = aliasReader(file);

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const linha = i + 1;

    // Peça apagada na origem — não entra no Dexo.
    const status = asString(read(row, "Cód Status", "Cod Status", "Status"));
    if (status && normName(status) === "EXCLUIDO") {
      excluidos++;
      continue;
    }

    const sku = asString(read(row, "Cod Peça", "Cod Peca", "# Cod Peca"));
    if (!sku) {
      semSku++;
      continue;
    }
    // Dedup intra-arquivo (case/espaço-insensível): 1ª ocorrência vence.
    const skuKey = sku.toLowerCase();
    if (seenSku.has(skuKey)) {
      duplicadosSku++;
      continue;
    }
    seenSku.add(skuKey);

    const rawLoc = asString(
      read(row, "Localização Produto", "Localizacao Produto", "Localizacao"),
    );
    let locationCode: string | null = null;
    let locationText: string | null = null;
    if (rawLoc) {
      locationCode = normalizeCodeFlat(rawLoc);
      if (locationCode) {
        locationText = rawLoc;
        if (!byCode.has(locationCode)) {
          byCode.set(locationCode, {
            code: locationCode,
            description: rawLoc,
            maxCapacity: 0, // 0 = sem limite (a checagem só liga com > 0)
            parentCode: null,
            linha,
          });
        }
      }
    }
    if (!locationCode) semLocalizacao++;

    const disponivel = asStock(
      read(row, "Qtd Disponivel", "Qtd Disponível", "Quantidade disponivel"),
    );
    const indisponivel = statusIndisponivel(status);
    if (indisponivel && disponivel > 0) estoqueZeradoPorStatus++;

    const condicao = asString(read(row, "Condição", "Condicao"));

    produtos.push({
      linha,
      sku,
      name: asString(read(row, "Nome Produto", "Nome Peca", "Nome")) ?? "(sem nome)",
      price: asNumber(read(row, "Preço", "Preco", "Valor")) ?? 0,
      stock: indisponivel ? 0 : disponivel,
      quality: condicao && normName(condicao) === "NOVO" ? "NOVO" : "SEMINOVO",
      status,
      qtdVendida: asNumber(read(row, "Qtd Vendida", "Quantidade vendida")),
      description: asString(read(row, "Descrição Produto", "Descricao Produto", "Descrição")),
      locationCode,
      locationText,
      etiqueta: asString(read(row, "Etiqueta")),
      mlCategoriaExterna: asString(read(row, "Categoria ML")),
    });
  }

  // Avisos de arquivo (não por linha) — entram no início, porque `addIssue`
  // corta no MAX_ISSUES e o aviso do arquivo é o mais importante.
  if (excluidos > 0) {
    avisos.unshift({
      motivo: `${excluidos} linha(s) com status "Excluido" foram ignoradas (peças apagadas no sistema de origem).`,
    });
  }
  if (semSku > 0) {
    avisos.unshift({
      motivo: `${semSku} linha(s) sem "Cod Peça" foram ignoradas.`,
    });
  }
  if (estoqueZeradoPorStatus > 0) {
    avisos.unshift({
      motivo:
        `${estoqueZeradoPorStatus} peça(s) entram com estoque ZERO porque o status na origem ` +
        `é "Vendido" ou "não estocado", mesmo tendo quantidade preenchida na planilha. ` +
        `O cadastro (nome, preço, descrição, localização) é criado normalmente — só a ` +
        `quantidade não é, para o cliente não anunciar peça que já saiu.`,
    });
  }

  return {
    produtos,
    locationItems: Array.from(byCode.values()),
    totalRows: file.rows.length,
    semSku,
    duplicadosSku,
    excluidos,
    semLocalizacao,
    estoqueZeradoPorStatus,
    avisos,
  };
}

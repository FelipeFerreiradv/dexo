import { ladoOuEixoOposto } from "../../lib/lado-e-eixo";

/**
 * REGRA DO RELIGAMENTO — para qual peca este anuncio deve apontar?
 * ================================================================
 *
 * Pura e sem I/O, como `veredito-fusao.ts` e pelo mesmo motivo: os scripts
 * falam com PRODUCAO ao serem carregados, entao importar o script para testar a
 * regra dispararia a operacao inteira.
 *
 * POR QUE A REGUA E MAIS DURA QUE A DO `corrigir-vinculo-anuncio-produto.ts`
 * Aquele script exige 0,70 de titulo e campeao unico. Nesta base cada canal de
 * evidencia, SOZINHO, ja errou com numero medido:
 *   - SKU: 182 de 1.385 pares com SKU igual eram outra peca; um cliente tem UM
 *     produto de SKU "1" e 7.328 anuncios carregando "1";
 *   - FOTO: elegeu o dono ERRADO em 104 de 126 clusters antes do
 *     particionamento por titulo;
 *   - TITULO: aprova peca espelhada — depois da canonizacao de lado/eixo o par
 *     "L/e" x "L/d" da 0,78, e `areTitlesSimilar` devolve true.
 * Dai a exigencia de DUAS TESTEMUNHAS INDEPENDENTES e o veto de lado/eixo
 * aplicado sobre TODOS os canais, inclusive foto.
 *
 * ⚠️ Escrever no banco por conta propria nao pode ser mais frouxo do que a
 * ingestao ja e: a propria aplicacao exige `areTitlesSimilar(..., 0.9)` para
 * APRENDER uma identidade sozinha (catalog-identity.service.ts).
 */

export const LIMIARES = {
  /** Titulo do campeao contra COALESCE(titleOverride, Product.name). */
  minTitulo: 0.85,
  /** O campeao tem de ganhar do segundo colocado com folga. */
  folgaSobreSegundo: 0.15,
  /** E tem de ganhar do produto ATUALMENTE apontado, senao so embaralha. */
  ganhoSobreAtual: 0.3,
  /** Acima disso o SKU e rotulo de caixa, nao identidade. */
  maxUsoDoSku: 3,
  /** Acima disso a foto e generica/de catalogo e casa o galpao inteiro. */
  maxUsoDaFoto: 9,
  /** Uma foto em comum e coincidencia; duas, nao. */
  minFotosEmComum: 2,
} as const;

export type Anuncio = {
  externo: string;
  titulo: string;
  /** `seller_custom_field` do anuncio. */
  sku: string | null;
  statusNoMl: string;
  quantidadeNoMl: number;
  contaId: string;
  /** Dono da CONTA de marketplace. */
  tenantDaConta: string;
};

export type Candidato = {
  id: string;
  nome: string;
  sku: string | null;
  /** Dono do PRODUTO. */
  tenantDoProduto: string;
  /** `stock - reservedStock` do candidato. */
  disponivel: number;
  /** Quantos ids de foto o candidato compartilha com o anuncio. */
  fotosEmComum: number;
  /** Em quantos anuncios do tenant esse `seller_sku` aparece. */
  usoDoSku: number;
  /** Maior numero de produtos que compartilham uma das fotos usadas na prova. */
  usoDaFoto: number;
  /** O candidato ja tem anuncio VIVO no ML nesta mesma conta? */
  temAnuncioVivoNaConta: boolean;
  /** Alguma das 25 colunas `*Override` do anuncio esta preenchida? */
  anuncioTemOverride: boolean;
  /** Existe ReceivableItem pendente/vencido apontando para o candidato? */
  recebivelPendente: boolean;
};

export type Contexto = {
  /** Semelhanca do campeao com o titulo do anuncio. */
  notaDoCampeao: number;
  /** Semelhanca do SEGUNDO colocado, ou null quando nao ha segundo. */
  notaDoSegundo: number | null;
  /** Semelhanca do produto ATUALMENTE apontado. */
  notaDoAtual: number;
  /** Algum canal independente apontou um produto DIFERENTE do campeao? */
  canalApontaOutroProduto: boolean;
};

export type Veredito = "RELIGAR" | "EMPILHADO" | "CONFLITO" | "REVISAR" | "NAO_APLICAVEL";

export type Decisao = {
  veredito: Veredito;
  /** Por que, em uma frase por motivo. Vazio quando RELIGAR. */
  motivos: string[];
  /** Quais canais independentes sustentaram o campeao. */
  testemunhas: string[];
};

/**
 * Canais que valem como SEGUNDA testemunha. Cada um e anulado pela propria
 * frequencia: identidade que se repete no catalogo inteiro nao identifica nada.
 */
function testemunhasDe(anuncio: Anuncio, candidato: Candidato): string[] {
  const provas: string[] = [];
  if (
    anuncio.sku &&
    candidato.sku &&
    String(anuncio.sku).trim() === String(candidato.sku).trim() &&
    candidato.usoDoSku <= LIMIARES.maxUsoDoSku
  ) {
    provas.push("sku");
  }
  if (
    candidato.fotosEmComum >= LIMIARES.minFotosEmComum &&
    candidato.usoDaFoto <= LIMIARES.maxUsoDaFoto
  ) {
    provas.push("foto");
  }
  return provas;
}

export function decidirReligamento(
  anuncio: Anuncio,
  candidato: Candidato | null,
  contexto: Contexto,
): Decisao {
  const motivos: string[] = [];

  // Anuncio que nao esta no ar nao expoe peca: nao ha pressa nem dano a impedir,
  // e o ML recusa mexer em item inativo.
  if (anuncio.statusNoMl !== "active" || anuncio.quantidadeNoMl <= 0) {
    return { veredito: "NAO_APLICAVEL", motivos: ["o anuncio nao esta no ar com quantidade"], testemunhas: [] };
  }
  if (!candidato) {
    return { veredito: "REVISAR", motivos: ["nenhuma peca do catalogo corresponde a este anuncio"], testemunhas: [] };
  }

  const testemunhas = testemunhasDe(anuncio, candidato);

  // Evidencia contraditoria e informacao, nao duvida: com dois canais
  // discordando, a chance de eu escolher o errado e metade, e o erro apaga a
  // evidencia que permitiria descobrir depois.
  if (contexto.canalApontaOutroProduto) {
    return { veredito: "CONFLITO", motivos: ["canais independentes apontam pecas diferentes"], testemunhas };
  }

  // O veto de lado/eixo vem cedo e vale para TODOS os canais, inclusive foto: o
  // desmanche fotografa a peca esquerda e usa a MESMA foto no anuncio da
  // direita, entao foto compartilhada prova "mesma familia", nunca "mesmo lado".
  if (ladoOuEixoOposto(anuncio.titulo, candidato.nome)) {
    return { veredito: "REVISAR", motivos: ["o anuncio e a peca divergem em lado ou eixo"], testemunhas };
  }

  // Empilhar e outro defeito, nao "religar com cuidado": nao existe unicidade
  // (produto, conta) e o sync empurra o estoque CHEIO do produto para cada
  // anuncio dele. Religar aqui troca baixa errada por venda dupla.
  if (candidato.temAnuncioVivoNaConta) {
    return { veredito: "EMPILHADO", motivos: ["a peca certa ja tem anuncio vivo nesta conta"], testemunhas };
  }

  // O banco aceitaria: a FK e so productId -> Product.id, e o DDL de 17/09
  // derrubou a trigger de tenant de proposito.
  if (candidato.tenantDoProduto !== anuncio.tenantDaConta) {
    return { veredito: "REVISAR", motivos: ["a peca e de outro cliente"], testemunhas };
  }

  if (contexto.notaDoCampeao < LIMIARES.minTitulo) {
    motivos.push(`titulo ${contexto.notaDoCampeao.toFixed(2)} abaixo de ${LIMIARES.minTitulo}`);
  }
  if (testemunhas.length === 0) {
    motivos.push("so o titulo concorda; nenhum canal independente confirma");
  }
  if (
    contexto.notaDoSegundo !== null &&
    contexto.notaDoCampeao - contexto.notaDoSegundo < LIMIARES.folgaSobreSegundo
  ) {
    motivos.push("empate com o segundo colocado");
  }
  if (contexto.notaDoCampeao - contexto.notaDoAtual < LIMIARES.ganhoSobreAtual) {
    motivos.push("o candidato nao e claramente melhor que a peca apontada hoje");
  }
  // Override sobrevive ao reaponte e continua publicando titulo, preco e foto da
  // peca ERRADA: o cliente olharia o anuncio "corrigido", veria o texto antigo e
  // concluiria que a correcao nao funcionou.
  if (candidato.anuncioTemOverride) {
    motivos.push("o anuncio tem override preenchido, que continuaria publicando a peca antiga");
  }
  // A vigilia de disponibilidade recolhe anuncio cuja peca nao tem saldo e cobre
  // a base em 24 h: religar para destino zerado tira o anuncio do ar no dia
  // seguinte ao aviso ao cliente.
  if (candidato.disponivel <= 0) {
    motivos.push("a peca certa esta sem saldo e o anuncio sairia do ar em 24 h");
  }
  if (candidato.recebivelPendente) {
    motivos.push("a peca certa tem venda de balcao em aberto");
  }

  if (motivos.length > 0) return { veredito: "REVISAR", motivos, testemunhas };
  return { veredito: "RELIGAR", motivos: [], testemunhas };
}

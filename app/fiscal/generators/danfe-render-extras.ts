/**
 * Projeções de LEITURA para o desenho dos documentos fiscais.
 *
 * Existem dois caminhos que alimentam os renderers e eles gravam os mesmos
 * dados com SHAPES DIFERENTES:
 *
 *   • caminho DB  — `NfeEmitida.*Json`, no formato do formulário
 *                   (`{meio, valor}`, `{cpfCnpj, nome, ...}`)
 *   • caminho XML — `projectParsedNfeToDraft`, no formato do parser da SEFAZ
 *                   (`{tPag, vPag}`, `{CNPJ, xNome, ...}`)
 *
 * Enquanto o DANFE era gerado uma única vez na autorização isso não aparecia.
 * Com o re-render a partir do XML autorizado, o renderer passa a receber os
 * DOIS shapes e precisa entender ambos — senão o cupom fiscal do consumidor sai
 * com "Outros / R$ 0,00" no lugar da forma de pagamento real.
 *
 * Este módulo é PURO (sem pdf-lib, sem I/O) e só LÊ: nenhuma função aqui
 * participa de cálculo fiscal, montagem de XML ou persistência. É plumbing de
 * apresentação — o que ele produz só é usado para desenhar.
 *
 * ⚠️ O parser roda com `parseTagValue: false` e `parseAttributeValue: false`
 * (`nfe-xml-parser.service.ts`), então TODO valor-folha vindo do XML chega como
 * **string**. Daí o `num()` explícito em vez de confiar nos tipos declarados.
 */

import { MEIO_PAGAMENTO_COD, type MeioPagamento } from "../domain/nfe.types";

// ═══════════════════════════════════════════════════════════════════
// Helpers de coerção
// ═══════════════════════════════════════════════════════════════════

/**
 * Número ou `null`. Devolve `null` (nunca 0) para ausente/vazio/inválido — a
 * distinção importa: "campo não informado" imprime vazio, "campo zero" imprime
 * "0,00", e trocar um pelo outro num DANFE é informação fiscal errada.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** String não-vazia (após trim) ou `null`. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ═══════════════════════════════════════════════════════════════════
// Pagamentos
// ═══════════════════════════════════════════════════════════════════

/** Rótulos de exibição por meio de pagamento do domínio. */
export const MEIO_PAGAMENTO_LABEL: Record<MeioPagamento, string> = {
  DINHEIRO: "Dinheiro",
  CHEQUE: "Cheque",
  CARTAO_CREDITO: "Cartão de crédito",
  CARTAO_DEBITO: "Cartão de débito",
  CREDITO_LOJA: "Crédito loja",
  VALE_ALIMENTACAO: "Vale alimentação",
  VALE_REFEICAO: "Vale refeição",
  VALE_PRESENTE: "Vale presente",
  VALE_COMBUSTIVEL: "Vale combustível",
  BOLETO: "Boleto bancário",
  DEPOSITO: "Depósito bancário",
  PIX: "PIX",
  TRANSFERENCIA: "Transferência bancária",
  SEM_PAGAMENTO: "Sem pagamento",
  OUTROS: "Outros",
};

/**
 * Inverso de `MEIO_PAGAMENTO_COD`: código SEFAZ (tPag) → rótulo.
 *
 * Os códigos 19..22 existem na tabela da SEFAZ mas não no enum do domínio (o
 * Dexo não os emite). Decodificá-los mesmo assim é o comportamento correto:
 * se o XML autorizado traz `tPag=20`, o rótulo certo é "Pagamento instantâneo
 * (PIX) - dinâmico", não "Outros".
 */
const TPAG_LABEL: Record<string, string> = (() => {
  const inverso: Record<string, string> = {};
  for (const [meio, cod] of Object.entries(MEIO_PAGAMENTO_COD)) {
    inverso[cod] = MEIO_PAGAMENTO_LABEL[meio as MeioPagamento];
  }
  return {
    ...inverso,
    "19": "Programa de fidelidade / cashback",
    "20": "Pagamento instantâneo (PIX) - dinâmico",
    "21": "Crédito em loja",
    "22": "Pagamento eletrônico não informado",
  };
})();

export interface PagamentoView {
  /** Rótulo pronto para desenhar. */
  label: string;
  /** Valor em reais. `null` quando o shape de origem não trouxe valor. */
  valor: number | null;
}

/**
 * Normaliza `pagamentosJson` vindo de QUALQUER um dos dois caminhos.
 *
 * Aceita `[{meio, valor}]` (DB) e `[{tPag, vPag}]` (XML). Entrada ausente ou
 * inesperada devolve `[]` — o chamador decide o que mostrar num cupom sem
 * bloco de pagamento.
 */
export function normalizePagamentos(raw: unknown): PagamentoView[] {
  if (!Array.isArray(raw)) return [];

  const out: PagamentoView[] = [];
  for (const p of raw) {
    if (!isRecord(p)) continue;

    // Shape do DB: { meio: "PIX", valor: 150 }
    const meio = str(p.meio);
    if (meio) {
      out.push({
        label: MEIO_PAGAMENTO_LABEL[meio as MeioPagamento] ?? meio,
        valor: num(p.valor),
      });
      continue;
    }

    // Shape do XML: { tPag: "17", vPag: "150.00" }
    const tPag = str(p.tPag);
    if (tPag) {
      // Normaliza para 2 dígitos: o parser devolve o texto do XML como está e
      // um "1" solto tem que casar com "01".
      const cod = tPag.padStart(2, "0");
      out.push({
        label: TPAG_LABEL[cod] ?? `Pagamento (código ${cod})`,
        valor: num(p.vPag),
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Transportadora
// ═══════════════════════════════════════════════════════════════════

export interface TransportadoraView {
  nome: string | null;
  cpfCnpj: string | null;
  inscricaoEstadual: string | null;
  endereco: string | null;
  municipio: string | null;
  uf: string | null;
}

/**
 * Normaliza `transportadoraJson` dos dois caminhos.
 *
 * DB:  `{cpfCnpj, nome, inscricaoEstadual, endereco, municipio, uf}`
 * XML: `{CNPJ, CPF, xNome, IE, xEnder, xMun, UF}`
 *
 * Devolve `null` quando não há transportadora — o bloco do DANFE continua
 * sendo desenhado (a norma exige o quadro), só que com as células vazias.
 */
export function normalizeTransportadora(raw: unknown): TransportadoraView | null {
  if (!isRecord(raw)) return null;

  const view: TransportadoraView = {
    nome: str(raw.nome) ?? str(raw.xNome),
    cpfCnpj: str(raw.cpfCnpj) ?? str(raw.CNPJ) ?? str(raw.CPF),
    inscricaoEstadual: str(raw.inscricaoEstadual) ?? str(raw.IE),
    endereco: str(raw.endereco) ?? str(raw.xEnder),
    municipio: str(raw.municipio) ?? str(raw.xMun),
    uf: str(raw.uf) ?? str(raw.UF),
  };

  // Objeto presente mas inteiramente vazio conta como "sem transportadora".
  const temAlgo = Object.values(view).some((v) => v !== null);
  return temAlgo ? view : null;
}

// ═══════════════════════════════════════════════════════════════════
// Volumes
// ═══════════════════════════════════════════════════════════════════

export interface VolumeView {
  quantidade: number | null;
  especie: string | null;
  marca: string | null;
  numeracao: string | null;
  pesoBruto: number | null;
  pesoLiquido: number | null;
}

/**
 * Normaliza `volumesJson` (só existe no caminho DB — o parser não extrai
 * `<vol>`). Consolida N volumes numa única linha, que é o que o quadro
 * "VOLUMES TRANSPORTADOS" do DANFE comporta: quantidades e pesos somam,
 * espécie/marca/numeração usam o primeiro valor preenchido.
 */
export function normalizeVolumes(raw: unknown): VolumeView | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const view: VolumeView = {
    quantidade: null,
    especie: null,
    marca: null,
    numeracao: null,
    pesoBruto: null,
    pesoLiquido: null,
  };

  const soma = (atual: number | null, v: unknown): number | null => {
    const n = num(v);
    if (n === null) return atual;
    return (atual ?? 0) + n;
  };

  for (const v of raw) {
    if (!isRecord(v)) continue;
    view.quantidade = soma(view.quantidade, v.quantidade);
    view.pesoBruto = soma(view.pesoBruto, v.pesoBruto);
    view.pesoLiquido = soma(view.pesoLiquido, v.pesoLiquido);
    view.especie = view.especie ?? str(v.especie);
    view.marca = view.marca ?? str(v.marca);
    view.numeracao = view.numeracao ?? str(v.numeracao);
  }

  const temAlgo = Object.values(view).some((v) => v !== null);
  return temAlgo ? view : null;
}

// ═══════════════════════════════════════════════════════════════════
// Duplicatas
// ═══════════════════════════════════════════════════════════════════

export interface DuplicataView {
  numero: string | null;
  vencimento: string | null;
  valor: number | null;
}

/** Normaliza `duplicatasJson` (`{numero, vencimento, valor}`, só caminho DB). */
export function normalizeDuplicatas(raw: unknown): DuplicataView[] {
  if (!Array.isArray(raw)) return [];
  const out: DuplicataView[] = [];
  for (const d of raw) {
    if (!isRecord(d)) continue;
    out.push({
      numero: str(d.numero) ?? str(d.nDup),
      vencimento: str(d.vencimento) ?? str(d.dVenc),
      valor: num(d.valor) ?? num(d.vDup),
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Impostos por item (lidos do dump bruto de <imposto>)
// ═══════════════════════════════════════════════════════════════════

export interface ItemImpostoView {
  /** Origem da mercadoria (0..8) como veio no XML. */
  origem: string | null;
  /** CST (regime normal) ou CSOSN (Simples), o que estiver presente. */
  cstCsosn: string | null;
  /** `true` quando o código lido é CSOSN — muda o RÓTULO da coluna do DANFE. */
  isCsosn: boolean;
  bcIcms: number | null;
  valorIcms: number | null;
  aliquotaIcms: number | null;
  valorIpi: number | null;
  aliquotaIpi: number | null;
}

/** Primeiro filho-objeto de um nó (o grupo ICMS vem como ICMS00/ICMSSN102/...). */
function primeiroGrupo(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  for (const v of Object.values(node)) {
    if (isRecord(v)) return v;
  }
  return null;
}

/**
 * Lê os campos do bloco `<imposto>` de um item do XML autorizado.
 *
 * `ParsedItem.imposto` é o dump BRUTO do bloco — o parser não o interpreta e
 * `projectParsedNfeToDraft` descarta tudo (`cstIcms: null`, `origem: 0`,
 * `tributosJson: null`). Sem esta leitura, o DANFE re-renderizado imprimiria
 * CST/CSOSN default e ICMS/IPI zerados por item, contradizendo o quadro
 * CÁLCULO DO IMPOSTO — que mostra o total real vindo de `<ICMSTot>`.
 *
 * O nome da tag do grupo de ICMS varia (ICMS00, ICMS20, ICMSSN102, ICMSSN900…),
 * então pegamos o primeiro grupo-objeto em vez de listar as ~20 variantes.
 *
 * Devolve `null` quando não há bloco `<imposto>` legível — o chamador então cai
 * no dado do banco (ou deixa as células vazias), em vez de inventar valores.
 */
export function readItemImposto(imposto: unknown): ItemImpostoView | null {
  if (!isRecord(imposto)) return null;

  const icms = primeiroGrupo(imposto.ICMS);
  // <IPI> tem os valores dentro de <IPITrib> (ou <IPINT>, que não tem valores).
  const ipiRoot = isRecord(imposto.IPI) ? imposto.IPI : null;
  const ipi = ipiRoot
    ? (isRecord(ipiRoot.IPITrib) ? ipiRoot.IPITrib : primeiroGrupo(ipiRoot))
    : null;

  const csosn = icms ? str(icms.CSOSN) : null;
  const cst = icms ? str(icms.CST) : null;

  const view: ItemImpostoView = {
    origem: icms ? str(icms.orig) : null,
    cstCsosn: csosn ?? cst,
    isCsosn: csosn !== null,
    bcIcms: icms ? num(icms.vBC) : null,
    valorIcms: icms ? num(icms.vICMS) : null,
    aliquotaIcms: icms ? num(icms.pICMS) : null,
    valorIpi: ipi ? num(ipi.vIPI) : null,
    aliquotaIpi: ipi ? num(ipi.pIPI) : null,
  };

  const temAlgo =
    view.origem !== null ||
    view.cstCsosn !== null ||
    view.bcIcms !== null ||
    view.valorIcms !== null ||
    view.aliquotaIcms !== null ||
    view.valorIpi !== null ||
    view.aliquotaIpi !== null;
  return temAlgo ? view : null;
}

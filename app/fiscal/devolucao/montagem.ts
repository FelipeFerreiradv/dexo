/**
 * Montagem (em memória) do rascunho de NF-e de DEVOLUÇÃO a partir de uma nota
 * ORIGINAL autorizada do Dexo e do XML autorizado já parseado.
 *
 * Garantias (plano §6.3, design de devolução §3.1):
 * - NUNCA copia id, chaveAcesso, protocolo, dataAutorizacao, caminhos de XML/DANFE,
 *   status, numero, motivoRejeicao, cStatRejeicao, orderId nem numeroPedido. O
 *   `numero` placeholder negativo é atribuído pelo REPOSITÓRIO na criação.
 * - Copia: destinatário (`destinatarioJson` da original — nunca o dest/xNome do
 *   XML, que em homologação é o literal da regra 598), `customerId`, itens do XML
 *   (código, descrição, NCM, CEST, unidade, origem, vUnCom) e o idDest.
 * - nº/série da referência vêm da CHAVE (reais), nunca de NfeEmitida.numero
 *   (na Focus o banco guardou números que não são os da SEFAZ).
 * - Item só entra com saldo disponível > 0; `quantidade = disponível`.
 *
 * Imports de servidor são SÓ de tipo (apagados na compilação).
 */

import type { NfeDestinatario } from "../../interfaces/nfe.interface";
import { normalizarChaveAcesso, parseChaveAcesso } from "../domain/chave-acesso-dv";
import { mapearCfopDevolucao } from "../domain/devolucao-cfop";
import type { DestinoOperacao, OrigemMercadoria } from "../domain/nfe.types";
import type { ParsedNfe } from "../sefaz/nfe-xml-parser.service";
import { dataBrasilISO } from "./modo-referencia";
import {
  calcularSaldoPorItem,
  ESCALA_QUANTIDADE,
  quantidadeParaUnidades,
  unidadesParaQuantidade,
  type LinhaSaldoDevolucao,
} from "./saldo";
import {
  crtDeRegime,
  MENSAGEM_MOTIVO_REVISAO,
  normalizarImpostoOriginal,
  proporcionalizar,
  round2,
} from "./tributacao";
import type {
  CrtEmitente,
  DevolucaoIssue,
  DevolucaoIssueCode,
  EscopoDevolucao,
  IdDest,
  OrigemDevolucaoSnapshot,
  OrigemItemSnapshot,
  RefDevolucaoItem,
  SaldoItemOriginal,
  SeveridadeIssue,
} from "./tipos";
import { validarDevolucao } from "./validacao";

export interface OriginalParaDevolucao {
  id: string;
  status: string;
  modelo: string;
  finalidade: string;
  tipoOperacao: string;
  destinoOperacao: string;
  ambiente: string;
  serie: number;
  numero: number;
  chaveAcesso: string | null;
  companyFiscalConfigId: string | null;
  customerId: string | null;
  destinatarioJson: unknown;
  dataEmissao: Date | string | null;
  xmlAutorizadoPath: string | null;
}

export interface ConfigParaDevolucao {
  id: string;
  cnpj: string;
  /** CRT explícito; ausente ⇒ derivado de `regimeTributario`. */
  crt?: CrtEmitente | string | null;
  regimeTributario?: string | null;
  serieNfe?: number | null;
  ambiente: string;
}

/** NfeItem da ORIGINAL (só para parear productId — informativo). */
export interface ItemNfeOriginal {
  numero: number;
  codigo: string;
  quantidade: number | string;
  valorTotal: number | string;
  productId: string | null;
}

export interface MontarRascunhoDeOriginalInput {
  original: OriginalParaDevolucao;
  parsed: ParsedNfe;
  idDestOriginal: IdDest;
  config: ConfigParaDevolucao;
  linhasSaldo: LinhaSaldoDevolucao[];
  itensNfe: ItemNfeOriginal[];
  escopo: EscopoDevolucao;
  tipo: "VENDA_ENTRADA";
}

export interface CabecalhoRascunhoDevolucao {
  tipoOperacao: "ENTRADA";
  finalidade: "DEVOLUCAO";
  modelo: "55";
  destinoOperacao: DestinoOperacao;
  indPresenca: "NAO_SE_APLICA";
  modalidadeFrete: "SEM_FRETE";
  /** SEM_PAGAMENTO ⇒ tPag 90 / forma_pagamento "90" (rejeição 871). */
  pagamentosJson: Array<{ meio: "SEM_PAGAMENTO"; valor: number }>;
  duplicatasJson: null;
  notasReferenciadasJson: null;
  naturezaOperacao: "DEVOLUCAO DE VENDA";
  informacoesComplementares: string;
  serie: number;
  ambiente: string;
  companyFiscalConfigId: string;
  customerId: string | null;
  destinatarioJson: NfeDestinatario | null;
}

/** Formato de NfeDraftItem (sem `id`: o repositório cria as linhas). */
export interface ItemRascunhoDevolucao {
  numero: number;
  productId: string | null;
  codigo: string;
  descricao: string;
  ncm: string;
  cfop: string;
  cest: string | null;
  origem: OrigemMercadoria;
  unidade: string;
  quantidade: number;
  valorUnitario: number;
  valorTotal: number;
  desconto: number | null;
  observacoes: null;
}

export interface RascunhoDevolucaoMontado {
  tipo: "VENDA_ENTRADA";
  fonte: "DEXO";
  escopo: EscopoDevolucao;
  indFinal: "1";
  cabecalho: CabecalhoRascunhoDevolucao;
  itens: ItemRascunhoDevolucao[];
  refs: RefDevolucaoItem[];
  /** Snapshot para NfeDevolucao.origensJson (todos os itens do XML). */
  origem: OrigemDevolucaoSnapshot;
  saldos: SaldoItemOriginal[];
  issues: DevolucaoIssue[];
}

const DESTINO_POR_IDDEST: Readonly<Record<IdDest, DestinoOperacao>> = {
  1: "INTERNA",
  2: "INTERESTADUAL",
  3: "EXTERIOR",
};

const soDigitos = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");

function normalizarCrt(v: unknown): CrtEmitente | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "1" || s === "2" || s === "3" || s === "4" ? s : null;
}

/** YYYY-MM-DD da emissão: data literal do dhEmi (hora local do emitente) ou a data BR do banco. */
function dataEmissaoISO(dhEmi: string | null | undefined, fallback: Date | string | null): string | null {
  const m = typeof dhEmi === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(dhEmi) : null;
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (fallback === null || fallback === undefined) return null;
  return dataBrasilISO(fallback instanceof Date ? fallback : new Date(fallback));
}

const isoParaBR = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function copiarDestinatario(v: unknown): NfeDestinatario | null {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return null;
  if (Object.keys(v as object).length === 0) return null;
  return JSON.parse(JSON.stringify(v)) as NfeDestinatario;
}

function origemMercadoria(orig: number | null): OrigemMercadoria {
  return (orig !== null && Number.isInteger(orig) && orig >= 0 && orig <= 8 ? orig : 0) as OrigemMercadoria;
}

export function montarRascunhoDeOriginal(input: MontarRascunhoDeOriginalInput): RascunhoDevolucaoMontado {
  const { original, parsed, config, idDestOriginal, escopo } = input;
  const issues: DevolucaoIssue[] = [];
  const add = (code: DevolucaoIssueCode, severidade: SeveridadeIssue, mensagem: string, ordem?: number) =>
    issues.push(ordem === undefined ? { code, severidade, mensagem } : { code, severidade, ordem, mensagem });

  // ── chave e identidade REAL da original ──
  const partes = parseChaveAcesso(parsed.chaveAcesso ?? "");
  const chaveBanco = original.chaveAcesso ? normalizarChaveAcesso(original.chaveAcesso) : null;
  const chave = partes?.chave ?? chaveBanco ?? "";
  if (partes && chaveBanco && chaveBanco !== partes.chave) {
    add("CHAVE_DIVERGENTE", "ERRO", "A chave do XML autorizado não confere com a chave gravada na nota original.");
  }
  if (parsed.protNFe && parsed.protNFe.cStat !== 100 && parsed.protNFe.cStat !== 150) {
    add("XML_SEM_AUTORIZACAO", "ERRO", "O XML da nota original não traz protocolo de autorização (cStat 100/150).");
  }
  const modeloOriginal = partes?.modelo ?? parsed.ide?.mod ?? original.modelo;
  const numeroReal = partes?.numero ?? parsed.ide?.nNF ?? null;
  const serieReal = partes?.serie ?? parsed.ide?.serie ?? null;
  const rotuloDoc = modeloOriginal === "65" ? "NFC-e" : "NF-e";
  const dataISO = dataEmissaoISO(parsed.ide?.dhEmi, original.dataEmissao);

  // ── elegibilidade da original (as regras de status/ambiente/emitente/CFOP/
  //    tributação ficam em validarDevolucao, logo abaixo) ──
  if (original.finalidade === "DEVOLUCAO") {
    add("JA_E_DEVOLUCAO", "ERRO", "Esta já é uma nota de devolução.");
  }
  if (original.tipoOperacao !== "SAIDA") {
    add("ORIGINAL_ENTRADA", "ERRO", "Nota de entrada — devolução de compra usa a devolução manual.");
  }
  const tpAmbConfig = config.ambiente === "PRODUCAO" ? "1" : "2";
  if (parsed.ide?.tpAmb && parsed.ide.tpAmb !== tpAmbConfig && original.ambiente === config.ambiente) {
    add("AMBIENTE_DIVERGENTE", "ERRO",
      "O XML da nota original é de outro ambiente (homologação × produção).");
  }

  // ── saldo por item do XML autorizado ──
  const saldos = calcularSaldoPorItem({
    itensOriginais: parsed.itens.map((i) => ({ nItem: i.nItem, quantidade: i.qCom })),
    linhas: input.linhasSaldo,
    chave,
  });
  const saldoPorNItem = new Map(saldos.map((s) => [s.nItem, s]));
  const totalmente = saldos.length > 0 && saldos.every((s) => (s.disponivel ?? 0) <= 0);
  if (saldos.length === 0) {
    add("TOTALMENTE_DEVOLVIDA", "ERRO", "A nota original não tem itens para devolver.");
  } else if (totalmente) {
    add("TOTALMENTE_DEVOLVIDA", "ERRO", "Todos os itens desta nota já foram devolvidos (ou estão em devolução).");
  } else if (
    escopo === "TOTAL" &&
    saldos.some((s) => s.quantidadeOriginal !== null && s.disponivel !== s.quantidadeOriginal)
  ) {
    add("PARCIALMENTE_DEVOLVIDA", "ERRO",
      "Esta nota já foi parcialmente devolvida — use a devolução parcial para o saldo restante.");
  }
  if (saldos.some((s) => s.emProcessamento > 0)) {
    add("EMISSAO_EM_ANDAMENTO", "AVISO",
      "Uma devolução desta nota está aguardando a SEFAZ; a quantidade dela já foi descontada do saldo.");
  }

  const destinatario = copiarDestinatario(original.destinatarioJson);
  if (!destinatario || !soDigitos(destinatario.cpfCnpj ?? "")) {
    add("DESTINATARIO_AUSENTE", "AVISO",
      "A nota original não identificou o destinatário. Informe CPF/CNPJ e nome de quem está devolvendo.");
  }

  // ── itens, referências e snapshot ──
  const crtEmitente = normalizarCrt(config.crt) ?? crtDeRegime(config.regimeTributario);
  const itens: ItemRascunhoDevolucao[] = [];
  const refs: RefDevolucaoItem[] = [];
  const itensSnapshot: OrigemItemSnapshot[] = [];

  for (const det of parsed.itens) {
    const imposto = normalizarImpostoOriginal(det.imposto);
    const origemIcms = imposto.icms?.orig ?? null;
    itensSnapshot.push({
      nItem: det.nItem,
      codigo: det.cProd,
      descricao: det.xProd,
      ncm: det.NCM,
      cest: det.CEST,
      unidade: det.uCom,
      cfop: det.CFOP,
      quantidade: det.qCom,
      valorUnitario: det.vUnCom,
      valorProduto: det.vProd,
      desconto: det.vDesc,
      origem: origemIcms,
      impostoOriginal: imposto,
    });

    const s = saldoPorNItem.get(det.nItem);
    const dispU = s && s.disponivel !== null ? quantidadeParaUnidades(s.disponivel) : null;
    if (dispU === null || dispU <= 0) continue;

    const ordem = itens.length + 1;
    const quantidade = unidadesParaQuantidade(dispU);
    const qComU = quantidadeParaUnidades(det.qCom);
    const valorTotal = round2((det.vUnCom * dispU) / ESCALA_QUANTIDADE);
    const desconto =
      det.vDesc > 0 && qComU !== null && qComU > 0
        ? dispU === qComU
          ? round2(det.vDesc)
          : round2((det.vDesc * dispU) / qComU)
        : null;

    const pares = input.itensNfe.filter(
      (n) =>
        n.codigo === det.cProd &&
        qComU !== null &&
        quantidadeParaUnidades(n.quantidade) === qComU &&
        Math.abs(Number(n.valorTotal) - det.vProd) < 0.01,
    );
    const productId = pares.length === 1 ? pares[0].productId ?? null : null;

    const cfopMapeamento = mapearCfopDevolucao({
      cfopOriginal: det.CFOP,
      tipo: "VENDA_ENTRADA",
      idDestOriginal,
      crt: crtEmitente,
    });

    const tributacao = proporcionalizar({
      impostoOriginal: imposto,
      qOriginal: det.qCom,
      qDevolvida: quantidade,
      vUnCom: det.vUnCom,
      crtEmitente,
      crtOriginal: parsed.emit?.CRT ?? null,
      tipoOperacao: "ENTRADA",
      // O MESMO desconto proporcional do NfeItem: a base que nasce do item fica líquida dele.
      descontoDevolvido: desconto,
    });

    itens.push({
      numero: ordem,
      productId,
      codigo: det.cProd,
      descricao: det.xProd,
      ncm: det.NCM,
      cfop: cfopMapeamento.cfop ?? "",
      cest: det.CEST,
      origem: origemMercadoria(origemIcms),
      unidade: det.uCom,
      quantidade,
      valorUnitario: det.vUnCom,
      valorTotal,
      desconto,
      observacoes: null,
    });

    refs.push({
      ordem,
      originalNfeId: original.id,
      chaveAcessoOriginal: chave,
      nItemOriginal: det.nItem,
      codigoOriginal: det.cProd,
      cfopOriginal: det.CFOP || null,
      quantidadeOriginal: s?.quantidadeOriginal ?? null,
      valorUnitarioOriginal: det.vUnCom,
      quantidade,
      valor: valorTotal,
      impostoOriginal: imposto,
      tributacao,
      cfopMapeamento,
    });
  }

  const informacoesComplementares =
    `Devolucao ref. ${rotuloDoc} ${numeroReal ?? ""} serie ${serieReal ?? ""}` +
    (dataISO ? ` de ${isoParaBR(dataISO)}` : "") +
    `, chave ${chave}`;

  const cabecalho: CabecalhoRascunhoDevolucao = {
    tipoOperacao: "ENTRADA",
    finalidade: "DEVOLUCAO",
    modelo: "55",
    destinoOperacao: DESTINO_POR_IDDEST[idDestOriginal],
    indPresenca: "NAO_SE_APLICA",
    modalidadeFrete: "SEM_FRETE",
    pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
    duplicatasJson: null,
    notasReferenciadasJson: null,
    naturezaOperacao: "DEVOLUCAO DE VENDA",
    informacoesComplementares,
    serie: config.serieNfe ?? 1,
    ambiente: config.ambiente,
    companyFiscalConfigId: config.id,
    customerId: original.customerId ?? null,
    destinatarioJson: destinatario,
  };

  // Mesmas regras da emissão, como prévia (CFOP, tributação, emitente, status…).
  if (itens.length > 0) {
    const previa = validarDevolucao({
      cabecalho: { tipo: "VENDA_ENTRADA", devolvidaAposEntrega: null, confirmadoSemXml: false },
      nota: {
        modelo: cabecalho.modelo,
        finalidade: cabecalho.finalidade,
        tipoOperacao: cabecalho.tipoOperacao,
        destinoOperacao: cabecalho.destinoOperacao,
        ambiente: config.ambiente,
        destinatarioCpfCnpj: destinatario?.cpfCnpj ?? null,
        notasReferenciadasJson: null,
        pagamentosJson: cabecalho.pagamentosJson,
        duplicatasJson: null,
      },
      emitente: { cnpj: config.cnpj, crt: crtEmitente },
      itens: itens.map((i) => ({ numero: i.numero, codigo: i.codigo, quantidade: i.quantidade, cfop: i.cfop })),
      refs: refs.map((r) => ({
        ordem: r.ordem,
        chaveAcesso: r.chaveAcessoOriginal,
        nItem: r.nItemOriginal,
        codigoOriginal: r.codigoOriginal,
        quantidade: r.quantidade,
        quantidadeOriginal: r.quantidadeOriginal,
        tributacao: r.tributacao,
      })),
      saldos: saldos.map((s) => ({ chaveAcesso: chave, nItem: s.nItem, disponivel: s.disponivel })),
      originais: [{ chaveAcesso: chave, status: original.status, ambiente: original.ambiente }],
      idDestOriginal,
    });
    const vistos = new Set(issues.map((i) => `${i.code}#${i.ordem ?? ""}`));
    for (const i of previa) {
      const k = `${i.code}#${i.ordem ?? ""}`;
      if (!vistos.has(k)) {
        vistos.add(k);
        issues.push(i);
      }
    }
  } else if (original.status !== "AUTHORIZED") {
    add(
      original.status === "CANCELLED" ? "ORIGINAL_CANCELADA" : "ORIGINAL_NAO_AUTORIZADA",
      "ERRO",
      original.status === "CANCELLED"
        ? "Nota cancelada — não há o que devolver."
        : "Só notas autorizadas pela SEFAZ podem ser devolvidas.",
    );
  }

  return {
    tipo: "VENDA_ENTRADA",
    fonte: "DEXO",
    escopo,
    indFinal: "1",
    cabecalho,
    itens,
    refs,
    origem: {
      chaveAcesso: chave,
      originalNfeId: original.id,
      modelo: modeloOriginal,
      numero: numeroReal ?? 0,
      serie: serieReal ?? 0,
      dataEmissao: dataISO,
      emitenteCnpjCpf: partes?.cnpjCpf ?? soDigitos(parsed.emit?.CNPJ ?? parsed.emit?.CPF ?? ""),
      crtOriginal: parsed.emit?.CRT ?? null,
      idDest: idDestOriginal,
      itens: itensSnapshot,
    },
    saldos,
    issues,
  };
}

/** Texto curto dos motivos de revisão (para mensagens da rota/UI). */
export function descreverMotivosRevisao(ref: Pick<RefDevolucaoItem, "tributacao">): string {
  return ref.tributacao.motivosRevisao.map((m) => MENSAGEM_MOTIVO_REVISAO[m] ?? m).join(" ");
}

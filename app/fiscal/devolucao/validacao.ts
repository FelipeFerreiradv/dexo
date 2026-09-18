/**
 * Validação da NF-e de DEVOLUÇÃO — roda ANTES do claim (erro de montagem queima
 * número no V1) e como prévia no GET do detalhe.
 *
 * Cada regra vira uma `DevolucaoIssue` com a rejeição SEFAZ equivalente na
 * mensagem (rastreabilidade). ERRO bloqueia a emissão; AVISO só informa.
 *
 * O contexto é montado pelo use case (rascunho + NfeItem + NfeDevolucaoItem +
 * saldo sob a MESMA regra de `saldo.ts` + originais do Dexo). Este módulo não
 * consulta nada: se um dado não veio (saldo, status da original), a regra que
 * depende dele simplesmente não é avaliada — exceto o saldo sem nenhuma fonte,
 * que exige `confirmadoSemXml`.
 *
 * Módulo PURO — seguro para backend, testes e client.
 */

import { parseChaveAcesso } from "../domain/chave-acesso-dv";
import {
  CFOPS_MEI_DEVOLUCAO,
  idDestDoCfop,
  isCfopPermitidoEmDevolucao,
} from "../domain/devolucao-cfop";
import { quantidadeParaUnidades, temAteQuatroCasas } from "./saldo";
import { MENSAGEM_MOTIVO_REVISAO, tagCompativelComCrt } from "./tributacao";
import type {
  CrtEmitente,
  DevolucaoIssue,
  DevolucaoIssueCode,
  IdDest,
  SeveridadeIssue,
  TipoDevolucao,
  TributacaoDevolucaoItem,
} from "./tipos";

export interface RefValidacaoDevolucao {
  ordem: number;
  chaveAcesso: string;
  nItem: number;
  codigoOriginal: string;
  quantidade: number | string;
  quantidadeOriginal?: number | string | null;
  tributacao?: TributacaoDevolucaoItem | null;
}

export interface ContextoValidacaoDevolucao {
  /** NfeDevolucao; null = rascunho com finalidade DEVOLUCAO sem cabeçalho (não gerenciada). */
  cabecalho: {
    tipo: TipoDevolucao;
    devolvidaAposEntrega: boolean | null;
    confirmadoSemXml?: boolean | null;
  } | null;
  nota: {
    modelo: string;
    finalidade: string;
    tipoOperacao: string;
    /** INTERNA | INTERESTADUAL | EXTERIOR (ou "1"/"2"/"3"). */
    destinoOperacao: string;
    ambiente?: string | null;
    destinatarioCpfCnpj?: string | null;
    notasReferenciadasJson?: unknown;
    pagamentosJson?: unknown;
    duplicatasJson?: unknown;
  };
  emitente: { cnpj: string; crt?: CrtEmitente | string | null };
  /** NfeItem da devolução. */
  itens: Array<{ numero: number; codigo: string; quantidade: number | string; cfop: string }>;
  /** NfeDevolucaoItem da devolução. */
  refs: RefValidacaoDevolucao[];
  /** Saldo por (chave, nItem) EXCLUINDO esta devolução. Ausente = não verificado aqui. */
  saldos?: Array<{ chaveAcesso: string; nItem: number; disponivel: number | null }> | null;
  /** Originais do Dexo encontradas pelas chaves. */
  originais?: Array<{ chaveAcesso: string; status: string; ambiente?: string | null }> | null;
  /** idDest da original (a devolução espelha). */
  idDestOriginal?: IdDest | null;
}

const IDDEST_POR_DESTINO: Readonly<Record<string, IdDest>> = {
  INTERNA: 1,
  INTERESTADUAL: 2,
  EXTERIOR: 3,
  "1": 1,
  "2": 2,
  "3": 3,
};

const REJEICAO_IDDEST: Readonly<Record<IdDest, string>> = {
  1: "733",
  2: "732",
  3: "731",
};

const soDigitos = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");

function listaNaoVazia(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && v !== undefined && typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

export function validarDevolucao(ctx: ContextoValidacaoDevolucao): DevolucaoIssue[] {
  const issues: DevolucaoIssue[] = [];
  const add = (code: DevolucaoIssueCode, severidade: SeveridadeIssue, mensagem: string, ordem?: number) =>
    issues.push(ordem === undefined ? { code, severidade, mensagem } : { code, severidade, ordem, mensagem });

  const { cabecalho, nota } = ctx;
  const tpNF: "0" | "1" = nota.tipoOperacao === "SAIDA" ? "1" : "0";
  const tipo: TipoDevolucao = cabecalho?.tipo ?? (tpNF === "1" ? "COMPRA_SAIDA" : "VENDA_ENTRADA");
  const crt = ctx.emitente.crt === null || ctx.emitente.crt === undefined ? null : String(ctx.emitente.crt);
  const cnpjEmitente = soDigitos(ctx.emitente.cnpj).padStart(14, "0");

  // ── cabeçalho ──
  if (!cabecalho) {
    add("NAO_GERENCIADA", "ERRO",
      "Nota de devolução sem o vínculo com a nota original (Rejeição 321). Crie a devolução pela nota original ou pela devolução manual.");
  } else if (cabecalho.devolvidaAposEntrega === null || cabecalho.devolvidaAposEntrega === undefined) {
    add("ESCOLHA_PENDENTE", "ERRO",
      "Responda se a mercadoria foi entregue e devolvida pelo cliente.");
  } else if (cabecalho.devolvidaAposEntrega !== true) {
    add("RECUSA_NAO_E_DEVOLUCAO", "ERRO",
      "Recusa ou não entrega não é devolução (finNFe 5, nota de crédito) — esta nota não pode ser emitida para esse caso.");
  }

  if (nota.finalidade !== "DEVOLUCAO") {
    add("FINALIDADE_NAO_DEVOLUCAO", "ERRO",
      "A finalidade da nota precisa ser Devolução (finNFe 4) para usar CFOP de devolução (Rejeição 328).");
  }
  if (nota.modelo !== "55") {
    add("MODELO_NAO_PERMITIDO", "ERRO",
      "Nota de devolução só pode ser NF-e modelo 55 — NFC-e não admite devolução (Rejeição 706/715).");
  }
  const tpEsperado = tipo === "COMPRA_SAIDA" ? "SAIDA" : "ENTRADA";
  if (nota.tipoOperacao !== tpEsperado) {
    add("TIPO_OPERACAO_INCOERENTE", "ERRO",
      tipo === "COMPRA_SAIDA"
        ? "Devolução de compra é nota de SAÍDA (tpNF=1)."
        : "Devolução de venda é nota de ENTRADA (tpNF=0).");
  }
  if (listaNaoVazia(nota.notasReferenciadasJson)) {
    add("NFREF_PROIBIDA", "ERRO",
      "Notas referenciadas do formulário não podem ir junto com a referência da devolução (Rejeição 1010). Remova-as — a referência é gerada pelo Dexo.");
  }
  if (
    Array.isArray(nota.pagamentosJson) &&
    nota.pagamentosJson.some((p) => (p as { meio?: unknown } | null)?.meio !== "SEM_PAGAMENTO")
  ) {
    add("PAGAMENTO_SERA_90", "AVISO",
      "Nota de devolução não tem forma de pagamento: será enviado \"Sem pagamento\" (tPag 90, Rejeição 871).");
  }
  if (listaNaoVazia(nota.duplicatasJson)) {
    add("COBRANCA_NAO_ENVIADA", "AVISO",
      "Nota de devolução não tem duplicatas: a cobrança informada não será enviada.");
  }

  const idDestNota = IDDEST_POR_DESTINO[String(nota.destinoOperacao ?? "")] ?? null;
  if (ctx.idDestOriginal && idDestNota && ctx.idDestOriginal !== idDestNota) {
    add("IDDEST_DIVERGENTE_ORIGINAL", "ERRO",
      "O destino da operação (idDest) precisa ser o mesmo da nota original.");
  }

  // ── itens × referências ──
  const itens = [...ctx.itens].sort((a, b) => a.numero - b.numero);
  const refs = [...ctx.refs].sort((a, b) => a.ordem - b.ordem);
  if (itens.length === 0) {
    add("SEM_ITENS", "ERRO", "Escolha pelo menos um item para devolver.");
  }
  if (itens.length === 0 || refs.length === 0) {
    add("REFERENCIA_AUSENTE", "ERRO",
      "NF-e de devolução sem documento fiscal referenciado (Rejeição 321).");
  }

  const refPorOrdem = new Map<number, RefValidacaoDevolucao>();
  for (const r of refs) if (!refPorOrdem.has(r.ordem)) refPorOrdem.set(r.ordem, r);

  const desalinhado =
    itens.length !== refs.length ||
    itens.some((it, i) => {
      const r = refs[i];
      if (!r || it.numero !== i + 1 || r.ordem !== i + 1) return true;
      if (String(it.codigo ?? "") !== String(r.codigoOriginal ?? "")) return true;
      const qi = quantidadeParaUnidades(it.quantidade);
      const qr = quantidadeParaUnidades(r.quantidade);
      return qi === null || qr === null || qi !== qr;
    });
  if (desalinhado && itens.length > 0 && refs.length > 0) {
    add("ITENS_DESALINHADOS", "ERRO",
      "Os itens da nota não correspondem às referências da devolução. Salve os itens pelo editor da devolução (Rejeição 321).");
  }

  // Itens sem referência na posição.
  for (const it of itens) {
    if (refs.length > 0 && !refPorOrdem.has(it.numero)) {
      add("REFERENCIA_AUSENTE", "ERRO",
        `Item ${it.numero} sem referência ao item da nota original (Rejeição 321).`, it.numero);
    }
  }

  // ── CFOP por item (o que o montador emite: NfeItem.cfop) ──
  for (const it of itens) {
    const cfop = soDigitos(it.cfop);
    if (!cfop) {
      add("CFOP_ESCOLHA_PENDENTE", "ERRO",
        `Item ${it.numero}: escolha o CFOP de devolução (Rejeição 327).`, it.numero);
      continue;
    }
    if (!isCfopPermitidoEmDevolucao(cfop, tpNF)) {
      add("CFOP_NAO_DEVOLUCAO", "ERRO",
        `Item ${it.numero}: o CFOP ${cfop} não é de devolução para esta operação (Rejeição 327).`, it.numero);
      continue;
    }
    const entrada = "123".includes(cfop[0]);
    if ((tpNF === "0") !== entrada) {
      add("CFOP_SENTIDO_INVALIDO", "ERRO",
        tpNF === "0"
          ? `Item ${it.numero}: CFOP de saída numa nota de entrada (Rejeição 519).`
          : `Item ${it.numero}: CFOP de entrada numa nota de saída (Rejeição 518).`,
        it.numero);
    }
    const idDestCfop = idDestDoCfop(cfop);
    if (idDestNota && idDestCfop && idDestCfop !== idDestNota) {
      add("CFOP_IDDEST_DIVERGENTE", "ERRO",
        `Item ${it.numero}: o CFOP ${cfop} não combina com o destino da operação (Rejeição ${REJEICAO_IDDEST[idDestCfop]}).`,
        it.numero);
    }
    if (crt === "4" && !CFOPS_MEI_DEVOLUCAO.has(cfop)) {
      add("CFOP_MEI_NAO_PERMITIDO", "ERRO",
        `Item ${it.numero}: MEI só pode usar os CFOPs de devolução 1202, 1553, 2202, 2553, 5202 e 6202 (Rejeição 1179).`,
        it.numero);
    }
  }

  // ── referências ──
  const saldoPorPar = new Map<string, number | null>();
  for (const s of ctx.saldos ?? []) {
    saldoPorPar.set(`${soDigitos(s.chaveAcesso)}#${s.nItem}`, s.disponivel);
  }
  const confirmadoSemXml = cabecalho?.confirmadoSemXml === true;
  const pares = new Set<string>();
  const emitentesReferenciados = new Set<string>();

  for (const r of refs) {
    const partes = parseChaveAcesso(r.chaveAcesso);
    const chave = partes?.chave ?? soDigitos(r.chaveAcesso);
    if (!partes || !partes.dvValido) {
      add("CHAVE_INVALIDA", "ERRO",
        `Item ${r.ordem}: chave de acesso da nota original inválida (44 dígitos com dígito verificador).`, r.ordem);
    } else {
      emitentesReferenciados.add(partes.cnpjCpf);
      if (partes.modelo !== "55" && partes.modelo !== "65") {
        add("MODELO_ORIGINAL_NAO_SUPORTADO", "ERRO",
          `Item ${r.ordem}: só NF-e (55) e NFC-e (65) podem ser referenciadas (modelo ${partes.modelo}).`, r.ordem);
      }
    }

    if (!Number.isInteger(r.nItem) || r.nItem < 1 || r.nItem > 990) {
      add("NITEM_INVALIDO", "ERRO",
        `Item ${r.ordem}: número do item da nota original fora de 1 a 990 (Rejeição 1048).`, r.ordem);
    }

    const par = `${chave}#${r.nItem}`;
    if (pares.has(par)) {
      add("REFERENCIA_DUPLICADA", "ERRO",
        `Item ${r.ordem}: o item ${r.nItem} da mesma nota original foi referenciado mais de uma vez (Rejeição 1072).`, r.ordem);
    }
    pares.add(par);

    const qU = quantidadeParaUnidades(r.quantidade);
    if (qU === null || qU <= 0 || !temAteQuatroCasas(r.quantidade)) {
      add("QUANTIDADE_INVALIDA", "ERRO",
        `Item ${r.ordem}: a quantidade devolvida precisa ser maior que zero, com no máximo 4 casas decimais.`, r.ordem);
    } else {
      const temSaldo = saldoPorPar.has(par);
      const disponivel = temSaldo ? saldoPorPar.get(par) ?? null : null;
      const qOrigU =
        r.quantidadeOriginal === null || r.quantidadeOriginal === undefined
          ? null
          : quantidadeParaUnidades(r.quantidadeOriginal);
      const disponivelU = disponivel === null ? null : quantidadeParaUnidades(disponivel);
      if (disponivelU !== null && qU > disponivelU) {
        add("SALDO_EXCEDIDO", "ERRO",
          `Item ${r.ordem}: quantidade maior que o saldo disponível para devolução (${disponivel}).`, r.ordem);
      } else if (disponivelU === null && qOrigU !== null && qU > qOrigU) {
        add("SALDO_EXCEDIDO", "ERRO",
          `Item ${r.ordem}: quantidade maior que a vendida na nota original (${r.quantidadeOriginal}).`, r.ordem);
      } else if (disponivelU === null && qOrigU === null && !confirmadoSemXml) {
        add("SALDO_NAO_VERIFICAVEL", "ERRO",
          `Item ${r.ordem}: sem o XML da nota original o saldo não pode ser conferido — confirme a devolução sem XML.`, r.ordem);
      }
    }

    const trib = r.tributacao;
    if (!trib) {
      add("TRIBUTACAO_AUSENTE", "ERRO", `Item ${r.ordem}: tributação da devolução não definida.`, r.ordem);
    } else {
      if (trib.requerRevisao && !trib.confirmada) {
        const motivos = trib.motivosRevisao.map((m) => MENSAGEM_MOTIVO_REVISAO[m] ?? m).join(" ");
        add("TRIBUTACAO_REVISAO_PENDENTE", "ERRO",
          `Item ${r.ordem}: revise e confirme a tributação. ${motivos}`.trim(), r.ordem);
      }
      if (!trib.icms.tag) {
        add("TRIBUTACAO_NAO_SUPORTADA", "ERRO",
          `Item ${r.ordem}: grupo de ICMS não suportado na devolução — ajuste o CST/CSOSN.`, r.ordem);
      } else if (!tagCompativelComCrt(trib.icms.tag, crt)) {
        add("TRIBUTACAO_REGIME_INCOMPATIVEL", "ERRO",
          `Item ${r.ordem}: ${trib.icms.tag.startsWith("ICMSSN") ? "CSOSN para emitente fora do Simples (Rejeição 590)" : "CST para emitente do Simples (Rejeição 591)"} — ajuste a tributação.`,
          r.ordem);
      }
      if (trib.ipiDevol) {
        const { pDevol, vIPIDevol } = trib.ipiDevol;
        if (!(pDevol > 0 && pDevol <= 100) || !(vIPIDevol >= 0)) {
          add("IPI_DEVOL_INVALIDO", "ERRO",
            `Item ${r.ordem}: percentual de IPI devolvido precisa estar entre 0 e 100 (grupo impostoDevol).`, r.ordem);
        }
      }
      if (trib.avisos.includes("PIS_CST_SAIDA_EM_ENTRADA") && tpNF === "0") {
        add("PIS_CST_SAIDA_EM_ENTRADA", "AVISO",
          `Item ${r.ordem}: CST de PIS/COFINS de saída numa nota de entrada — confirme com o contador.`, r.ordem);
      }
      if (trib.avisos.includes("IBS_CBS_NAO_ENVIADO")) {
        add("IBS_CBS_NAO_ENVIADO", "AVISO",
          `Item ${r.ordem}: IBS/CBS da nota original não é enviado na devolução.`, r.ordem);
      }
    }
  }

  // ── emitente(s) das chaves ──
  if (emitentesReferenciados.size > 1) {
    add("EMITENTES_DIVERSOS", "ERRO",
      "Todas as notas referenciadas precisam ser do mesmo emitente (Rejeição 1193).");
  }
  const [emitenteReferenciado] = Array.from(emitentesReferenciados);
  if (emitentesReferenciados.size === 1 && emitenteReferenciado) {
    if (tpNF === "1") {
      const dest = soDigitos(nota.destinatarioCpfCnpj ?? "").padStart(14, "0");
      if (dest !== emitenteReferenciado) {
        add("DESTINATARIO_NAO_E_EMITENTE_ORIGINAL", "ERRO",
          "Na devolução de compra o destinatário precisa ser o emitente da nota original (Rejeição 1194).");
      }
    } else if (emitenteReferenciado !== cnpjEmitente) {
      add("EMITENTE_ORIGINAL_DIVERGENTE", "ERRO",
        "Na devolução de venda a nota original precisa ter sido emitida por este mesmo CNPJ (regra do Dexo, mais estrita que a 1193).");
    }
  }

  // ── originais do Dexo ──
  const vistas = new Set<string>();
  for (const o of ctx.originais ?? []) {
    const chave = parseChaveAcesso(o.chaveAcesso)?.chave ?? soDigitos(o.chaveAcesso);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    if (o.status === "CANCELLED") {
      add("ORIGINAL_CANCELADA", "ERRO", `A nota original ${chave} está cancelada — não há o que devolver.`);
    } else if (o.status !== "AUTHORIZED") {
      add("ORIGINAL_NAO_AUTORIZADA", "ERRO", `A nota original ${chave} não está autorizada.`);
    }
    if (o.ambiente && nota.ambiente && o.ambiente !== nota.ambiente) {
      add("AMBIENTE_DIVERGENTE", "ERRO",
        "A nota original e a devolução estão em ambientes diferentes (homologação × produção).");
    }
  }

  return issues;
}

export function issuesBloqueantes(issues: readonly DevolucaoIssue[]): DevolucaoIssue[] {
  return issues.filter((i) => i.severidade === "ERRO");
}

export function temBloqueio(issues: readonly DevolucaoIssue[]): boolean {
  return issues.some((i) => i.severidade === "ERRO");
}

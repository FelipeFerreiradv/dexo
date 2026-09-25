// Tudo que o editor da devolução (`devolucao-editor.tsx`) DECIDE, sem desenhar:
// as linhas e o que cada uma manda no corpo do PUT, o que trava o "Salvar
// devolução", o que a tela diz quando o servidor recusa, a pergunta da entrega,
// os valores calculados e os totais da nota — módulo puro, testado em node.
//
// ── Os casos reais (DLS AUTO PEÇAS, 24/09/2026) ──
//  * Zerar uma peça e salvar DERRUBAVA a tela: o editor casava a linha do
//    estado com a do servidor pela POSIÇÃO (`value.itens[index]`), e o servidor
//    devolve menos itens. Aqui a linha é casada pela CHAVE (nota + item da nota
//    original), nunca pela posição.
//  * O CST digitado depois da alíquota apagava a alíquota, e a caixa mostrava o
//    que estava gravado enquanto o corpo levava outra coisa. Aqui o corpo SAI do
//    que a tela mostra — código e alíquota juntos —, montado na hora de salvar.
//  * "Dados da requisição inválidos." jogava fora a frase certa do servidor
//    (`erros[]`, por item e campo). Aqui cada frase vai para a peça dela.
//  * A caixinha "A mercadoria foi entregue…" transformava "não respondi" em
//    "não". Aqui a resposta tem três estados, e sem resposta nada é enviado.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import type {
  AtualizarItemBody,
  DevolucaoDetalhe,
  DevolucaoItemDetalhe,
} from "@/app/fiscal/devolucao/contrato";
import type {
  EscopoDevolucao,
  TipoDevolucao,
  TotaisDevolucao,
  TributacaoDevolucaoItem,
  TributacaoOverride,
} from "@/app/fiscal/devolucao/tipos";
import { quantidadeParaUnidades } from "@/app/fiscal/devolucao/saldo";
import { reais, round2 } from "@/app/fiscal/devolucao/tributacao";
import {
  BLOQUEIO_CONFIRMAR,
  campoIcms,
  codigoIcmsDoItem,
  overrideComIcms,
  type CampoIcmsView,
} from "./nfe-devolucao-icms-campo";
import {
  BLOQUEIO_CONFIRMAR_PIS_COFINS,
  aliquotaGravadaNoSimples,
  aliquotaPisCofins,
  campoPisCofins,
  lerAliquota,
  overrideComPisCofins,
  textoDaAliquota,
  type CampoPisCofinsView,
  type TributoPisCofins,
} from "./nfe-devolucao-pis-cofins-campo";
import { CFOP_OBRIGATORIO } from "./nfe-devolucao-cfop-campo";
import { formatarQuantidade, lerQuantidadeDevolucao, type QuantidadeLida } from "./nfe-devolucao-quantidade-campo";
import {
  listarOrdens,
  semPrefixoDeItem,
  viewPendencias,
  type PendenciasDevolucaoView,
} from "./nfe-devolucao-pendencias-ui";
import { TITULO_DEVOLUCOES_EM_ANDAMENTO, dataCurta } from "./nfe-devolucoes-abertas-ui";

// ─────────────────────────────── a linha ───────────────────────────────

/** Nota + item da nota original: a identidade da peça, que não muda ao salvar. */
export function chaveDaLinha(chaveAcesso: string, nItem: number): string {
  return `${chaveAcesso}#${nItem}`;
}

/**
 * O que ela mexeu numa peça, NESTA visita ao passo. Imposto `null` = não mexeu
 * (a tela mostra o gravado e o corpo não leva nada daquele tributo).
 */
export interface LinhaEditor {
  chaveAcesso: string;
  nItem: number;
  /** O texto da caixa de quantidade — vazio não é zero. */
  quantidadeTexto: string;
  /** Tirada da devolução pelo botão (ou já fora dela, depois de salvar). */
  tirada: boolean;
  cfop: string;
  /** A caixinha "Revisei" como ELA deixou; o corpo ainda passa pelas travas. */
  confirmar: boolean;
  icms: string | null;
  pIcms: string | null;
  pis: string | null;
  pPis: string | null;
  cofins: string | null;
  pCofins: string | null;
  /** true = marcou "Não devolver o IPI"; false = desmarcou; null = não mexeu. */
  ipiRetirar: boolean | null;
}

export function linhaDoItem(item: DevolucaoItemDetalhe): LinhaEditor {
  return {
    chaveAcesso: item.chaveAcesso,
    nItem: item.nItem,
    quantidadeTexto: formatarQuantidade(item.quantidade),
    tirada: false,
    cfop: item.cfop ?? "",
    confirmar: item.tributacao?.confirmada === true,
    icms: null,
    pIcms: null,
    pis: null,
    pPis: null,
    cofins: null,
    pCofins: null,
    ipiRetirar: null,
  };
}

/** Peça que saiu da devolução ao salvar: continua na tela, com como voltar. */
export function linhaForaDaDevolucao(item: DevolucaoItemDetalhe): LinhaEditor {
  return { ...linhaDoItem(item), tirada: true, confirmar: false };
}

/** As linhas do detalhe, pela chave — o estado inicial do editor. */
export function linhasDoDetalhe(detalhe: Pick<DevolucaoDetalhe, "itens">): Record<string, LinhaEditor> {
  const out: Record<string, LinhaEditor> = {};
  for (const i of detalhe.itens ?? []) out[chaveDaLinha(i.chaveAcesso, i.nItem)] = linhaDoItem(i);
  return out;
}

function mesmaQuantidade(a: number | null | undefined, b: number | null | undefined): boolean {
  const x = quantidadeParaUnidades(a);
  const y = quantidadeParaUnidades(b);
  return x !== null && y !== null && x === y;
}

// ─────────────────────────── passo 3: produtos ───────────────────────────

export interface ProdutoDaLinha {
  quantidade: QuantidadeLida;
  /** A peça sai (ou continua fora) da devolução ao salvar. */
  fora: boolean;
  /** "" quando o CFOP está escolhido (ou a peça está fora). */
  erroCfop: string;
  /** true ⇒ trava o "Salvar devolução". */
  bloqueia: boolean;
  /** O item do corpo do PUT; `null` = não vai (fora da devolução ou com erro). */
  corpo: AtualizarItemBody | null;
  /** Há mudança não salva nesta peça. */
  mudou: boolean;
}

/**
 * A peça no passo "Produtos". `naDevolucao` = ela está hoje no rascunho
 * gravado (as que saíram ao salvar ficam na tela com `naDevolucao:false`).
 */
export function produtoDaLinha(entrada: {
  linha: LinhaEditor;
  item: DevolucaoItemDetalhe;
  naDevolucao: boolean;
}): ProdutoDaLinha {
  const { linha, item, naDevolucao } = entrada;
  const quantidade = lerQuantidadeDevolucao(linha.quantidadeTexto, item.disponivel);
  if (linha.tirada || quantidade.estado === "ZERO") {
    return { quantidade, fora: true, erroCfop: "", bloqueia: false, corpo: null, mudou: naDevolucao };
  }
  if (quantidade.bloqueia || quantidade.valor === null) {
    return { quantidade, fora: false, erroCfop: "", bloqueia: true, corpo: null, mudou: true };
  }
  const cfop = linha.cfop.trim();
  const erroCfop = cfop === "" ? CFOP_OBRIGATORIO : "";
  const mesma = naDevolucao && mesmaQuantidade(quantidade.valor, item.quantidade);
  const corpo: AtualizarItemBody | null =
    erroCfop === ""
      ? {
          chaveAcesso: linha.chaveAcesso,
          nItem: linha.nItem,
          quantidade: quantidade.valor,
          cfop,
          // Mudou a quantidade, mudam os valores: a revisão feita vale para os antigos.
          confirmarTributacao: mesma ? item.tributacao?.confirmada === true : false,
        }
      : null;
  return {
    quantidade,
    fora: false,
    erroCfop,
    bloqueia: erroCfop !== "",
    corpo,
    mudou: !naDevolucao || !mesma || cfop !== (item.cfop ?? ""),
  };
}

export const NENHUMA_PECA = "Deixe pelo menos uma peça nesta devolução, com quantidade maior que zero.";
export const TRAVADO_PRODUTOS = "Acerte o que está marcado nas peças acima para poder salvar.";
export const TIRAR_DA_DEVOLUCAO = "Tirar desta devolução";
export const DESFAZER_TIRAR = "Desfazer";
export const DEVOLVER_TAMBEM = "Devolver esta peça também";
export const SAI_AO_SALVAR = "Esta peça sai da devolução quando você salvar.";
export const FORA_DA_DEVOLUCAO = "Esta peça está fora desta devolução.";

/**
 * As peças da nota original que estão FORA desta devolução e podem voltar (K11):
 *  - as que ela tirou NESTA visita ao passo (`locais`), com o que ela tinha
 *    escrito — o detalhe do servidor não as traz mais como itens;
 *  - as que o servidor lista em `itensForaDaDevolucao` (tiradas antes de
 *    recarregar a página, ou que nunca entraram). Sem elas, a peça tirada
 *    sumia de vez depois de recarregar, e o único jeito de trazê-la de volta
 *    era começar outra devolução.
 * Uma vez cada (a peça é a chave), nunca as que já estão na devolução, em
 * ordem de nota e item — a mesma ordem antes e depois de recarregar.
 */
export function pecasForaDaDevolucao(
  detalhe: Pick<DevolucaoDetalhe, "itens" | "itensForaDaDevolucao">,
  locais: readonly DevolucaoItemDetalhe[],
): DevolucaoItemDetalhe[] {
  const dentro = new Set((detalhe.itens ?? []).map((i) => chaveDaLinha(i.chaveAcesso, i.nItem)));
  const servidor = Array.isArray(detalhe.itensForaDaDevolucao) ? detalhe.itensForaDaDevolucao : [];
  const vistas = new Set<string>();
  const out: DevolucaoItemDetalhe[] = [];
  // As locais primeiro: numa peça tirada agora, vale o que ela tinha escrito.
  for (const i of [...locais, ...servidor]) {
    if (!i || typeof i.chaveAcesso !== "string" || typeof i.nItem !== "number") continue;
    const k = chaveDaLinha(i.chaveAcesso, i.nItem);
    if (dentro.has(k) || vistas.has(k)) continue;
    vistas.add(k);
    out.push(i);
  }
  return out.sort((a, b) => (a.chaveAcesso === b.chaveAcesso ? a.nItem - b.nItem : a.chaveAcesso < b.chaveAcesso ? -1 : 1));
}

/**
 * A quantidade que a caixa mostra quando a peça VOLTA para a devolução
 * ("Devolver esta peça também" / "Desfazer"): a que ela tinha escrito; senão a
 * da peça (o que ainda pode ser devolvido, que o servidor sugere). Quando o
 * saldo não é conhecido (devolução pela chave, sem o XML: a peça vem com 0), a
 * caixa fica VAZIA e pede a quantidade — com 0 a peça sairia de novo ao salvar,
 * sem ela entender por quê.
 */
export function quantidadeAoVoltar(
  linha: Pick<LinhaEditor, "quantidadeTexto">,
  item: Pick<DevolucaoItemDetalhe, "quantidade">,
): string {
  const escrito = (linha.quantidadeTexto ?? "").trim();
  if (escrito !== "" && lerQuantidadeDevolucao(escrito, null).estado !== "ZERO") return linha.quantidadeTexto;
  return typeof item.quantidade === "number" && Number.isFinite(item.quantidade) && item.quantidade > 0
    ? formatarQuantidade(item.quantidade)
    : "";
}

/**
 * O que já aconteceu com esta peça da nota original, numa linha: quanto veio
 * na nota, quanto já foi devolvido, quanto está em envio e quanto está em
 * outros rascunhos (que não seguram a peça). "" quando não há nada a dizer.
 */
export function saldoDaPeca(
  item: Pick<DevolucaoItemDetalhe, "quantidadeOriginal" | "devolvidaAutorizada" | "emProcessamento" | "emRascunho" | "unidade">,
): string {
  const un = typeof item.unidade === "string" && item.unidade.trim() !== "" ? ` ${item.unidade.trim()}` : "";
  const partes: string[] = [];
  if (typeof item.quantidadeOriginal === "number") partes.push(`Na nota original: ${formatarQuantidade(item.quantidadeOriginal)}${un}`);
  if ((item.devolvidaAutorizada ?? 0) > 0) partes.push(`já devolvida: ${formatarQuantidade(item.devolvidaAutorizada)}`);
  if ((item.emProcessamento ?? 0) > 0) partes.push(`em envio à SEFAZ: ${formatarQuantidade(item.emProcessamento)}`);
  if ((item.emRascunho ?? 0) > 0) partes.push(`em outro rascunho: ${formatarQuantidade(item.emRascunho)}`);
  return partes.join(" · ");
}

const STATUS_EM_ENVIO: ReadonlySet<string> = new Set(["VALIDATING", "SIGNING", "SENDING"]);
const STATUS_SEM_EFEITO: ReadonlySet<string> = new Set(["CANCELLED", "INUTILIZED", "DENIED"]);

/**
 * Onde mais esta peça está (`outrasDevolucoes`, sem canceladas/inutilizadas):
 * uma frase por devolução, dizendo qual é e o que isso muda. A DLS chegou a ter
 * 5 rascunhos da MESMA nota da DISAUTO sem saber — o primeiro emitido tira a
 * quantidade dos outros, e só se descobria na hora de emitir o segundo.
 */
export function textosOutrasDevolucoes(
  item: Pick<DevolucaoItemDetalhe, "outrasDevolucoes" | "unidade">,
): string[] {
  const lista = Array.isArray(item.outrasDevolucoes) ? item.outrasDevolucoes : [];
  const un = typeof item.unidade === "string" && item.unidade.trim() !== "" ? ` ${item.unidade.trim()}` : "";
  const out: string[] = [];
  for (const o of lista) {
    if (!o || typeof o !== "object" || typeof o.status !== "string") continue;
    // Cancelada/inutilizada não segura nada (o servidor já não manda; defesa).
    if (STATUS_SEM_EFEITO.has(o.status)) continue;
    const qtd = typeof o.quantidade === "number" && Number.isFinite(o.quantidade) ? `${formatarQuantidade(o.quantidade)}${un}` : "";
    const numero =
      typeof o.numero === "number" && o.numero > 0
        ? `nº ${o.numero}${typeof o.serie === "number" ? ` (série ${o.serie})` : ""}`
        : "";
    if (o.status === "AUTHORIZED") {
      out.push(`Já foi devolvida na NF-e de devolução ${numero || "autorizada"}${numero ? ", autorizada" : ""}${qtd ? `: ${qtd}` : ""}.`);
    } else if (STATUS_EM_ENVIO.has(o.status)) {
      out.push(
        `Também está na NF-e de devolução ${numero ? `${numero}, ` : ""}que está sendo enviada à SEFAZ${qtd ? ` (${qtd})` : ""}: essa quantidade já saiu do que ainda pode ser devolvido; se ela for recusada, volta.`,
      );
    } else {
      const qual =
        o.status === "REJECTED"
          ? `na devolução ${numero ? `${numero} ` : ""}recusada pela SEFAZ, que continua aberta`
          : "em outro rascunho de devolução";
      const quando = dataCurta(o.criadaEm);
      const detalhe = [qtd, quando ? `começado em ${quando}` : ""].filter((x) => x !== "").join(", ");
      out.push(
        `Também está ${qual}${detalhe ? ` (${detalhe})` : ""}. Rascunho não segura a peça: a primeira devolução emitida tira a quantidade da outra. Veja em "Notas Emitidas" › "${TITULO_DEVOLUCOES_EM_ANDAMENTO}".`,
      );
    }
  }
  return out;
}

// ─────────────────────────── passo 8: impostos ───────────────────────────

export const REVISAO_DEPOIS_DE_SALVAR =
  "Salve primeiro para ver o valor calculado com o que você mudou; depois marque que revisou.";
export const REVISAO_ACERTE_ALIQUOTA = "Acerte a alíquota antes de marcar que revisou.";

export const TRAVADO_IMPOSTOS = "Acerte a alíquota marcada acima para poder salvar.";
export const CFOP_FALTA_NO_PASSO_3 =
  'O CFOP desta peça ainda não foi escolhido: escolha no passo 3 ("Produtos"). Sem ele o Dexo não salva esta devolução.';
export const SEM_REFERENCIA_ORIGINAL =
  "Devolução pela chave, sem o XML: não há imposto da nota original para conferir. Confirme os códigos com a sua contadora.";
/** A alíquota do ICMS numa devolução de COMPRA: a da nota de compra (Res. CGSN 140/2018, art. 59, no Simples). */
export const DICA_ALIQUOTA_COMPRA = "Na devolução de compra, a alíquota e a base vêm da nota de compra.";
export const VALORES_DO_ULTIMO_SALVAMENTO = "Você mudou algo neste item: salve para ver os valores novos.";

export const IPI_NAO_DEVOLVER = "Não devolver o IPI desta peça";
export const IPI_NAO_DEVOLVER_AVISO =
  "Só com orientação da sua contadora: sem o IPI devolvido na nota, o fornecedor não recupera o IPI desta peça.";

/** A nota original destacou IPI neste item (a devolução leva o IPI devolvido)? */
export function temIpiDevolvido(item: Pick<DevolucaoItemDetalhe, "tributacao" | "referenciaOriginal">): boolean {
  const t = item.tributacao;
  return (
    !!t?.ipiDevol ||
    (Array.isArray(t?.motivosRevisao) && t.motivosRevisao.includes("IPI_DESTACADO")) ||
    (item.referenciaOriginal?.ipi?.vIPI ?? 0) > 0
  );
}

/** O IPI devolvido foi RETIRADO e gravado assim (`ipiDevol:false` num save anterior). */
function ipiRetiradoNoServidor(t: TributacaoDevolucaoItem | null | undefined): boolean {
  return !!t && t.ipiDevol === null && Array.isArray(t.motivosRevisao) && t.motivosRevisao.includes("IPI_DESTACADO");
}

export interface ImpostosDaLinha {
  icms: CampoIcmsView;
  /** O texto que a caixa de alíquota do ICMS mostra (o gravado até ela mexer). */
  pIcmsTexto: string;
  pis: CampoPisCofinsView;
  pPisTexto: string;
  cofins: CampoPisCofinsView;
  pCofinsTexto: string;
  ipi: { tem: boolean; retirado: boolean };
  /**
   * Problema da alíquota de cada tributo ("" quando não há). Trava o salvar
   * quando ela mexeu no tributo; no valor gravado, só trava a revisão.
   */
  erros: { icms: string; pis: string; cofins: string };
  /**
   * No Simples, a alíquota GRAVADA que a caixa travada em 0 vai corrigir ao
   * salvar ("Estava gravada a alíquota de 1,64% da COFINS…"); "" quando não há.
   */
  aliquotaGravada: { pis: string; cofins: string };
  /** true ⇒ o "Salvar devolução" fica travado por esta peça. */
  bloqueiaSalvar: boolean;
  /** O ajuste que vai no corpo — só dos tributos que ela MUDOU. */
  tributacao: TributacaoOverride | undefined;
  /** A mudança altera valor que só o servidor calcula (a tela ainda mostra o antigo). */
  valoresPendentes: boolean;
  /** Por que o "Revisei" está travado ("" = pode marcar). */
  bloqueioRevisao: string;
  /** O `confirmarTributacao` que vai no corpo. */
  confirmar: boolean;
  /** Há mudança de imposto não salva nesta peça. */
  mudou: boolean;
}

export function impostosDaLinha(entrada: {
  linha: LinhaEditor;
  item: DevolucaoItemDetalhe;
  emitente: DevolucaoDetalhe["emitente"] | null | undefined;
  tipo: TipoDevolucao;
}): ImpostosDaLinha {
  const { linha, item, emitente, tipo } = entrada;
  const t = item.tributacao;

  // ── ICMS ── (o seletor e a recusa são os do `campoIcms`, intocados)
  const icms = campoIcms({ emitente, icmsDoItem: t?.icms, escolhido: linha.icms });
  const pIcmsTexto = linha.pIcms ?? textoDaAliquota(t?.icms?.pICMS);
  let pIcms: number | undefined;
  let erroIcms = "";
  if (!icms.precisaEscolher && icms.exigeAliquota) {
    const a = lerAliquota(pIcmsTexto, "do ICMS");
    if (a.ok) pIcms = a.valor;
    else erroIcms = a.motivo;
  }
  const mexeuIcms = linha.icms !== null || linha.pIcms !== null;
  const icmsMudou =
    !icms.precisaEscolher &&
    erroIcms === "" &&
    (icms.valor !== codigoIcmsDoItem(t?.icms) || (icms.exigeAliquota && pIcms !== t?.icms?.pICMS));
  let tributacao: TributacaoOverride | undefined = icmsMudou
    ? overrideComIcms(undefined, { codigo: icms.valor, crt: icms.crt, pICMS: icms.exigeAliquota ? pIcms : undefined })
    : undefined;

  // ── PIS e COFINS ── (código e alíquota SEMPRE juntos)
  const umTributo = (tributo: TributoPisCofins) => {
    const codigoEscolhido = tributo === "pis" ? linha.pis : linha.cofins;
    const pEscolhido = tributo === "pis" ? linha.pPis : linha.pCofins;
    const gravado = t?.[tributo];
    const campo = campoPisCofins({
      emitente,
      tipo,
      tributo,
      gravado,
      escolhido: codigoEscolhido,
      codigoDaNota: item.referenciaOriginal?.[tributo]?.cst ?? null,
    });
    // No Simples a caixa é TRAVADA em 0 (decisão 2 do dono): mostra 0 e o corpo
    // leva 0, seja o que for que estiver gravado ou tiver sido digitado antes.
    const texto = campo.aliquotaTravadaEmZero ? "0" : (pEscolhido ?? textoDaAliquota(gravado?.p));
    let p: number | undefined;
    let erro = "";
    if (!campo.precisaEscolher && campo.exigeAliquota) {
      const a = aliquotaPisCofins({ campo, tipo, texto });
      if (a.ok) p = a.valor;
      else erro = a.motivo;
    }
    const mexeu = codigoEscolhido !== null || pEscolhido !== null;
    const mudou =
      !campo.precisaEscolher &&
      erro === "" &&
      (campo.valor !== (gravado?.cst ?? null) || (campo.exigeAliquota && p !== gravado?.p));
    // Alíquota > 0 GRAVADA numa empresa do Simples (a DLS chegou a gravar COFINS
    // a 1,64%): a caixa já mostra 0 e `mudou` já é true — o corpo leva o 0. A
    // frase diz o que estava gravado; nada muda no banco sem ela salvar.
    const gravadaNoSimples =
      campo.aliquotaTravadaEmZero && typeof gravado?.p === "number" && gravado.p > 0
        ? aliquotaGravadaNoSimples(tributo, gravado.p)
        : "";
    return { campo, texto, p, erro, mexeu, mudou, gravadaNoSimples };
  };
  const pis = umTributo("pis");
  const cofins = umTributo("cofins");
  for (const [tributo, x] of [["pis", pis], ["cofins", cofins]] as const) {
    if (x.mudou) {
      tributacao = overrideComPisCofins(tributacao, { tributo, codigo: x.campo.valor, p: x.p, crt: x.campo.crt, tipo });
    }
  }

  // ── IPI devolvido ──
  const ipiTem = temIpiDevolvido(item);
  const ipiServidor = ipiRetiradoNoServidor(t);
  const ipiRetirado = linha.ipiRetirar ?? ipiServidor;
  const ipiMudou = ipiTem && linha.ipiRetirar !== null && linha.ipiRetirar !== ipiServidor;
  if (ipiMudou) tributacao = { ...(tributacao ?? {}), ipiDevol: !linha.ipiRetirar };

  const bloqueiaSalvar = (mexeuIcms && erroIcms !== "") || (pis.mexeu && pis.erro !== "") || (cofins.mexeu && cofins.erro !== "");
  const valoresPendentes =
    (icmsMudou && icms.exigeAliquota && (pIcms ?? 0) > 0) ||
    (pis.mudou && pis.campo.exigeAliquota && (pis.p ?? 0) > 0) ||
    (cofins.mudou && cofins.campo.exigeAliquota && (cofins.p ?? 0) > 0) ||
    ipiMudou;

  const bloqueioRevisao = icms.precisaEscolher
    ? BLOQUEIO_CONFIRMAR
    : pis.campo.precisaEscolher || cofins.campo.precisaEscolher
      ? BLOQUEIO_CONFIRMAR_PIS_COFINS
      : erroIcms !== "" || pis.erro !== "" || cofins.erro !== ""
        ? REVISAO_ACERTE_ALIQUOTA
        : valoresPendentes
          ? REVISAO_DEPOIS_DE_SALVAR
          : "";

  return {
    icms,
    pIcmsTexto,
    pis: pis.campo,
    pPisTexto: pis.texto,
    cofins: cofins.campo,
    pCofinsTexto: cofins.texto,
    ipi: { tem: ipiTem, retirado: ipiRetirado },
    erros: { icms: erroIcms, pis: pis.erro, cofins: cofins.erro },
    aliquotaGravada: { pis: pis.gravadaNoSimples, cofins: cofins.gravadaNoSimples },
    bloqueiaSalvar,
    tributacao,
    valoresPendentes,
    bloqueioRevisao,
    confirmar: linha.confirmar && bloqueioRevisao === "",
    mudou:
      tributacao !== undefined ||
      bloqueiaSalvar ||
      linha.confirmar !== (t?.confirmada === true),
  };
}

/** O item do corpo no passo "Impostos": quantidade e CFOP gravados, impostos da tela. */
export function corpoDoItemImpostos(entrada: {
  linha: LinhaEditor;
  item: DevolucaoItemDetalhe;
  impostos: ImpostosDaLinha;
}): AtualizarItemBody {
  const { linha, item, impostos } = entrada;
  const corpo: AtualizarItemBody = {
    chaveAcesso: item.chaveAcesso,
    nItem: item.nItem,
    quantidade: item.quantidade,
    cfop: (linha.cfop || item.cfop || "").trim(),
    confirmarTributacao: impostos.confirmar,
  };
  if (impostos.tributacao) corpo.tributacao = impostos.tributacao;
  return corpo;
}

// ─────────────────────────── passo 1: a pergunta ───────────────────────────

/**
 * O rótulo do "Sim" é o MESMO texto que o catálogo de pendências manda marcar
 * ("A mercadoria foi entregue e está sendo devolvida"); a pergunta de cima é a
 * do tipo da devolução — numa devolução de COMPRA quem recebeu foi ela, não um
 * cliente.
 */
export const ENTREGA_SIM = "A mercadoria foi entregue e está sendo devolvida";

export interface PerguntaEntrega {
  pergunta: string;
  sim: string;
  nao: string;
  /** Sem resposta: o que acontece. */
  semResposta: string;
  /** "Não" escolhido: o que acontece. */
  seNao: string;
}

export function perguntaEntrega(tipo: TipoDevolucao | null | undefined): PerguntaEntrega {
  const compra = tipo === "COMPRA_SAIDA";
  return {
    pergunta: compra
      ? "As peças chegaram até você e agora estão voltando para o fornecedor?"
      : "A peça chegou ao cliente e agora está voltando para você?",
    sim: compra ? `${ENTREGA_SIM} ao fornecedor` : `${ENTREGA_SIM} pelo cliente`,
    nao: compra
      ? "Não: a mercadoria foi recusada na entrega e não chegou a entrar"
      : "Não: o cliente recusou a mercadoria na entrega",
    semResposta: "Responda para poder emitir: sem essa resposta a devolução não sai.",
    seNao:
      "Recusa na entrega não é devolução: com esta resposta o Dexo não emite esta nota. Confirme com a sua contadora como registrar a recusa.",
  };
}

/**
 * O topo do quadro da devolução. Dizia "Devolução de compra (saída)" e
 * "Operação exclusivamente fiscal. O estoque não será alterado." — "saída" e
 * "operação fiscal" são palavras da contadora; a dona do desmanche quer saber
 * para onde a peça vai e se o estoque mexe.
 */
export function cabecalhoDevolucao(tipo: TipoDevolucao | null | undefined): { titulo: string; estoque: string } {
  return {
    titulo:
      tipo === "VENDA_ENTRADA"
        ? "Devolução de venda — o cliente devolveu a peça (nota de entrada)"
        : "Devolução de compra — a peça volta para o fornecedor (nota de saída)",
    estoque: "Esta nota é só fiscal: o Dexo não mexe no estoque das peças por causa dela.",
  };
}

/** "Nota do fornecedor: NF-e nº 852899, série 1" — de quem é a nota que está voltando. */
export function textoNotaOriginal(
  tipo: TipoDevolucao | null | undefined,
  o: { numero: number; serie: number },
): string {
  return `${tipo === "VENDA_ENTRADA" ? "Sua nota de venda" : "Nota do fornecedor"}: NF-e nº ${o.numero}, série ${o.serie}`;
}

/** O escopo agora é DERIVADO das quantidades (o servidor ignora o que a tela mandar). */
export function textoEscopo(escopo: EscopoDevolucao | null | undefined): string {
  return escopo === "TOTAL"
    ? 'Esta devolução leva todas as peças da nota original, na quantidade inteira. Para devolver só parte, ajuste as quantidades no passo 3 ("Produtos").'
    : 'Esta devolução leva só parte da nota original (algumas peças, ou parte da quantidade). As quantidades se ajustam no passo 3 ("Produtos").';
}

// ─────────────────────────── títulos e valores ───────────────────────────

/**
 * "Item 1 — 33603-3 — RETENTOR" com "(item 5 da nota original)" embaixo: o
 * número de cima é o MESMO das pendências ("Falta confirmar a tributação dos
 * itens 1 e 2"); o de baixo, o da nota do fornecedor.
 */
export function tituloDaLinha(i: {
  ordem?: number | null;
  codigo?: string | null;
  descricao?: string | null;
  nItem: number;
}): { titulo: string; origem: string } {
  const nome = [i.codigo, i.descricao].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" — ");
  const titulo = typeof i.ordem === "number" && i.ordem > 0 ? `Item ${i.ordem}${nome ? ` — ${nome}` : ""}` : nome || "Peça";
  return { titulo, origem: `(item ${i.nItem} da nota original)` };
}

function percentual(p: number): string {
  return `${String(round2(p)).replace(".", ",")}%`;
}

export interface ValorTributo {
  tributo: string;
  texto: string;
}

/**
 * Os valores do item como vão sair na nota — os do ÚLTIMO salvamento (é o
 * servidor quem calcula). A base aparece junto: "1,65%" ao lado de uma peça de
 * R$ 123,56 não chega a R$ 1,79 sem ela (a base do PIS da DISAUTO já exclui o ICMS).
 */
export function valoresDaTributacao(t: TributacaoDevolucaoItem | null | undefined): ValorTributo[] {
  if (!t) return [];
  const um = (tributo: string, vBC: number, p: number, v: number): ValorTributo => ({
    tributo,
    texto:
      (v ?? 0) > 0 || (vBC ?? 0) > 0
        ? `base ${reais(vBC ?? 0)} × ${percentual(p ?? 0)} = ${reais(v ?? 0)}`
        : "sem valor na nota",
  });
  const out = [
    um("ICMS", t.icms?.vBC ?? 0, t.icms?.pICMS ?? 0, t.icms?.vICMS ?? 0),
    um("PIS", t.pis?.vBC ?? 0, t.pis?.p ?? 0, t.pis?.v ?? 0),
    um("COFINS", t.cofins?.vBC ?? 0, t.cofins?.p ?? 0, t.cofins?.v ?? 0),
  ];
  if (t.ipiDevol) {
    out.push({
      tributo: "IPI devolvido",
      texto: `${percentual(t.ipiDevol.pDevol)} do IPI da nota original = ${reais(t.ipiDevol.vIPIDevol)}`,
    });
  } else if (ipiRetiradoNoServidor(t)) {
    out.push({ tributo: "IPI devolvido", texto: "não vai nesta nota (marcado para não devolver)" });
  }
  return out;
}

export interface LinhaTotal {
  rotulo: string;
  valor: string;
  destaque: boolean;
}

export interface QuadroTotais {
  titulo: string;
  /** "" quando os valores já estão fechados. */
  previa: string;
  /** O valor da nota e do que ele é feito. */
  nota: LinhaTotal[];
  /** Os impostos destacados (informativos: ICMS, PIS e COFINS não somam ao valor da nota). */
  impostos: LinhaTotal[];
}

export const TITULO_TOTAIS = "Valores da nota de devolução";

export function quadroTotais(t: TotaisDevolucao | null | undefined): QuadroTotais | null {
  if (!t || typeof t !== "object" || typeof t.totalNota !== "number") return null;
  const linha = (rotulo: string, valor: number, destaque = false): LinhaTotal => ({ rotulo, valor: reais(valor), destaque });
  const nota: LinhaTotal[] = [linha("Produtos", t.totalProdutos ?? 0)];
  if ((t.totalDesconto ?? 0) > 0) nota.push({ rotulo: "Desconto", valor: `− ${reais(t.totalDesconto)}`, destaque: false });
  if ((t.totalFrete ?? 0) > 0) nota.push(linha("Frete", t.totalFrete));
  if ((t.totalIpiDevol ?? 0) > 0) nota.push(linha("IPI devolvido", t.totalIpiDevol));
  nota.push(linha("Valor da nota", t.totalNota, true));
  const impostos: LinhaTotal[] = [
    linha("Base do ICMS", t.totalBcIcms ?? 0),
    linha("ICMS", t.totalIcms ?? 0),
    linha("PIS", t.totalPis ?? 0),
    linha("COFINS", t.totalCofins ?? 0),
  ];
  const pendentes = Array.isArray(t.itensPendentes) ? t.itensPendentes.filter((n) => typeof n === "number") : [];
  const previa =
    t.completo === true
      ? ""
      : pendentes.length > 0
        ? `Prévia: ainda falta fechar a tributação ${pendentes.length === 1 ? "do item" : "dos itens"} ${listarOrdens(pendentes)}, então estes valores podem mudar.`
        : "Prévia: ainda falta fechar a tributação, então estes valores podem mudar.";
  return { titulo: TITULO_TOTAIS, previa, nota, impostos };
}

// ─────────────────────────── recusa do servidor ───────────────────────────

/** A peça como a tela a mostra — para achar de quem é cada frase do servidor. */
export interface PecaDaTela {
  chaveAcesso: string;
  nItem: number;
  ordem: number | null;
  codigo: string;
}

export interface FalhaSalvar {
  /** A frase de cima. */
  mensagem: string;
  /** Frases sem peça ("Escolha pelo menos um item…"). */
  gerais: string[];
  /** Frases de cada peça, pela chave da linha. */
  porLinha: Record<string, string[]>;
  /** As pendências da recusa (409/422 com `issues`), para o quadro de sempre. */
  pendencias: PendenciasDevolucaoView | null;
}

const ROTULO_DO_CAMPO: ReadonlyArray<readonly [RegExp, string]> = [
  [/^quantidade$/, "Quantidade"],
  [/^cfop$/, "CFOP"],
  [/^tributacao\.icms\.(cst|csosn)$/, "Código do ICMS"],
  [/^tributacao\.icms\.pICMS$/, "Alíquota do ICMS"],
  [/^tributacao\.icms\.modBC$/, "Base do ICMS"],
  [/^tributacao\.icms$/, "ICMS"],
  [/^tributacao\.pis\.cst$/, "Código do PIS"],
  [/^tributacao\.pis\.p$/, "Alíquota do PIS"],
  [/^tributacao\.pis$/, "PIS"],
  [/^tributacao\.cofins\.cst$/, "Código da COFINS"],
  [/^tributacao\.cofins\.p$/, "Alíquota da COFINS"],
  [/^tributacao\.cofins$/, "COFINS"],
  [/^tributacao\.ipiDevol$/, "IPI devolvido"],
  [/^tributacao$/, "Impostos"],
  [/^confirmarTributacao$/, "Revisei a tributação"],
  [/^chaveAcesso$/, "Nota original"],
  [/^nItem$/, "Número do item na nota original"],
];

export function rotuloDoCampo(sufixo: string): string {
  for (const [re, rotulo] of ROTULO_DO_CAMPO) if (re.test(sufixo)) return rotulo;
  return "";
}

export const FALHA_GENERICA = "Não foi possível salvar a devolução.";
export const FALHA_VEJA_AS_PECAS = "Não foi possível salvar: veja abaixo o que corrigir.";

/**
 * A recusa do servidor, traduzida para a tela: cada `erros[]` do 400 vai para a
 * PEÇA dele e cada `issues[]` do 409/422 também — pela peça (`chaveAcesso` +
 * `nItem` da issue) quando o servidor manda, e pela `ordem` só na falta. O índice
 * `itens[i]` é o do corpo ENVIADO — que não leva as peças tiradas —, então a
 * peça sai de `nItem`/`chaveAcesso` do próprio erro ou do que foi enviado,
 * nunca da posição na tela.
 */
export function falhaDoSalvar(entrada: {
  corpo: unknown;
  enviado: ReadonlyArray<{ chaveAcesso: string; nItem: number }>;
  pecas: readonly PecaDaTela[];
  passo: number;
}): FalhaSalvar {
  const c = (entrada.corpo && typeof entrada.corpo === "object" ? entrada.corpo : {}) as {
    error?: unknown;
    code?: unknown;
    erros?: unknown;
    issues?: unknown;
  };
  const erroServidor = typeof c.error === "string" && c.error.trim() !== "" ? c.error.trim() : "";
  const gerais: string[] = [];
  const porLinha: Record<string, string[]> = {};
  const achar = (chaveAcesso: unknown, nItem: unknown): PecaDaTela | null =>
    typeof chaveAcesso === "string" && typeof nItem === "number"
      ? entrada.pecas.find((p) => p.chaveAcesso === chaveAcesso && p.nItem === nItem) ?? null
      : null;
  const empurrar = (peca: PecaDaTela, frase: string) => {
    const k = chaveDaLinha(peca.chaveAcesso, peca.nItem);
    const lista = (porLinha[k] ??= []);
    if (!lista.includes(frase)) lista.push(frase);
  };

  if (Array.isArray(c.erros)) {
    for (const bruto of c.erros) {
      if (!bruto || typeof bruto !== "object") continue;
      const e = bruto as { campo?: unknown; mensagem?: unknown; nItem?: unknown; chaveAcesso?: unknown };
      const mensagem = typeof e.mensagem === "string" ? e.mensagem.trim() : "";
      if (mensagem === "") continue;
      const m = typeof e.campo === "string" ? /^itens\[(\d+)\](?:\.(.+))?$/.exec(e.campo) : null;
      if (!m) {
        gerais.push(mensagem);
        continue;
      }
      // O servidor manda `nItem` (e `chaveAcesso`) lidos do corpo enviado; servidor
      // antigo não manda, e aí vale o que foi enviado naquela posição.
      const enviado = entrada.enviado[Number(m[1])];
      const chaveAcesso = typeof e.chaveAcesso === "string" ? e.chaveAcesso : enviado?.chaveAcesso;
      const nItem = typeof e.nItem === "number" ? e.nItem : enviado?.nItem;
      const peca = achar(chaveAcesso, nItem);
      const sufixo = m[2] ?? "";
      const rotulo = rotuloDoCampo(sufixo);
      const passo3 = sufixo === "cfop" && entrada.passo !== 3 ? ' Escolha o CFOP no passo 3 ("Produtos").' : "";
      const frase = `${rotulo ? `${rotulo}: ` : ""}${mensagem}${passo3}`;
      if (peca) empurrar(peca, frase);
      else gerais.push(typeof nItem === "number" ? `Item ${nItem} da nota original — ${frase}` : frase);
    }
  }

  let pendencias: PendenciasDevolucaoView | null = null;
  if (Array.isArray(c.issues) && c.issues.length > 0) {
    pendencias = viewPendencias(c.issues, erroServidor || undefined);
    for (const bruto of c.issues) {
      if (!bruto || typeof bruto !== "object") continue;
      const i = bruto as { ordem?: unknown; mensagem?: unknown; nItem?: unknown; chaveAcesso?: unknown };
      // A PEÇA (nota original + item) quando o servidor manda — ela não muda ao
      // tirar outra peça da devolução. A `ordem` é a posição gravada, e numa
      // recusa do passo 3 que tira ou traz peça ela já não bate com a tela: só
      // vale na falta da peça (servidor antigo).
      const pelaPeca = achar(i.chaveAcesso, i.nItem);
      const temPeca = typeof i.chaveAcesso === "string" && typeof i.nItem === "number";
      const peca = pelaPeca ?? (!temPeca && typeof i.ordem === "number" ? entrada.pecas.find((p) => p.ordem === i.ordem) ?? null : null);
      const frase = typeof i.mensagem === "string" ? semPrefixoDeItem(i.mensagem) : "";
      if (peca && frase !== "") empurrar(peca, frase);
    }
  }

  const temDetalhe = gerais.length > 0 || Object.keys(porLinha).length > 0;
  const mensagem =
    c.code === "PAYLOAD_INVALIDO" && temDetalhe
      ? FALHA_VEJA_AS_PECAS
      : erroServidor || FALHA_GENERICA;
  return { mensagem, gerais, porLinha, pendencias };
}

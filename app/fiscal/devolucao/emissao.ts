import type { NfeDraftResponse } from "../../interfaces/nfe.interface";
import type { NfeItemTributos, CstPisCofins } from "../domain/nfe.types";
import type { IndFinalDevolucao, ModoReferenciaDevolucao, RefDevolucaoItem, TotaisDevolucao, TributacaoDevolucaoItem } from "./tipos";
import { PIS_COFINS_CST_SUPORTADOS, round2 } from "./tributacao";
import { isNfeFreteMedidasEnabled } from "../domain/frete";

/** Built on the server from managed references, never accepted from the emission request. */
export interface ContextoEmissaoDevolucao {
  modoReferencia: ModoReferenciaDevolucao;
  indFinal: IndFinalDevolucao;
  refs: Array<Pick<RefDevolucaoItem,"ordem"|"chaveAcessoOriginal"|"nItemOriginal"|"tributacao">>;
}
export function tributosDevolucao(t: TributacaoDevolucaoItem): NfeItemTributos {
  return {bcIcms:t.icms.vBC,aliquotaIcms:t.icms.pICMS,valorIcms:t.icms.vICMS,
    bcIpi:0,aliquotaIpi:0,valorIpi:0,bcPis:t.pis.vBC,aliquotaPis:t.pis.p,valorPis:t.pis.v,
    bcCofins:t.cofins.vBC,aliquotaCofins:t.cofins.p,valorCofins:t.cofins.v,valorTotalTributos:round2(t.icms.vICMS+t.pis.v+t.cofins.v)};
}
/**
 * A tributação deste item pode ir ao XML? Mesma régua de `calcularDevolucao`:
 * grupo de ICMS da allowlist, revisão confirmada, CST de PIS e de COFINS que o
 * montador emite, e nada de ICMS-ST pendurado (o construtor ainda não o escreve).
 */
export function tributacaoEmitivel(t: TributacaoDevolucaoItem | null | undefined): t is TributacaoDevolucaoItem {
  return !!t && !!t.icms.tag && !(t.requerRevisao && !t.confirmada)
    && PIS_COFINS_CST_SUPORTADOS.has(t.pis.cst ?? "") && PIS_COFINS_CST_SUPORTADOS.has(t.cofins.cst ?? "")
    && !t.motivosRevisao.includes("ICMS_ST_NAO_SUPORTADO");
}

export interface EntradaTotaisDevolucao {
  /** NfeItem da devolução (valorTotal = vProd, desconto = vDesc). */
  itens: ReadonlyArray<{ valorTotal: number | string; desconto?: number | string | null }>;
  refs: ReadonlyArray<{ ordem: number; tributacao: TributacaoDevolucaoItem | null | undefined }>;
  /** NfeEmitida.valorFrete; só conta com o frete ligado (mesma regra da emissão). */
  valorFrete?: number | string | null;
}

/**
 * Os totais da devolução — a MESMA conta que vai ao XML (`calcularDevolucao`
 * usa esta função), exposta para a tela mostrar ANTES de emitir. Não lança com
 * tributação incompleta: soma o que está gravado e marca `completo:false`.
 */
export function totaisDevolucao(e: EntradaTotaisDevolucao): TotaisDevolucao {
  const trib = (r: {tributacao: TributacaoDevolucaoItem | null | undefined}) => r.tributacao ?? null;
  const sum = (fn:(t:TributacaoDevolucaoItem)=>number) => round2(e.refs.reduce((n,r)=>{const t=trib(r);return t?n+fn(t):n;},0));
  const totalProdutos=round2(e.itens.reduce((n,i)=>n+Number(i.valorTotal),0));
  const totalDesconto=round2(e.itens.reduce((n,i)=>n+Number(i.desconto ?? 0),0));
  const totalIpiDevol=sum(t=>t.ipiDevol?.vIPIDevol ?? 0);
  const totalFrete=isNfeFreteMedidasEnabled()?Number(e.valorFrete ?? 0):0;
  const itensPendentes=e.itens.map((_,i)=>i+1).filter(ordem=>!tributacaoEmitivel(e.refs.find(r=>r.ordem===ordem)?.tributacao));
  return {totalProdutos,totalDesconto,totalFrete,totalBcIcms:sum(t=>t.icms.vBC),totalIcms:sum(t=>t.icms.vICMS),
    totalPis:sum(t=>t.pis.v),totalCofins:sum(t=>t.cofins.v),totalIpiDevol,
    totalNota:round2(totalProdutos-totalDesconto+totalFrete+totalIpiDevol),completo:itensPendentes.length===0,itensPendentes};
}

export function calcularDevolucao(draft: NfeDraftResponse, ctx: ContextoEmissaoDevolucao): NfeDraftResponse {
  const itens = draft.itens.map((item,index) => {
    const t = ctx.refs.find(r=>r.ordem===index+1)?.tributacao;
    if (!t || !t.icms.tag || (t.requerRevisao && !t.confirmada)) throw new Error("Tributação da devolução incompleta");
    // Defesa em profundidade (validarDevolucao já barra): sem CST de PIS/COFINS
    // o montador SEFAZ trocaria em silêncio pelo padrão do regime e a Focus
    // receberia null; com ICMS-ST na original, a nota sairia sem o ST.
    if (!tributacaoEmitivel(t)) throw new Error("Tributação da devolução incompleta");
    return {...item,numero:index+1,cstIcms:t.icms.csosn ?? t.icms.cst,cstPis:t.pis.cst as CstPisCofins,cstCofins:t.cofins.cst as CstPisCofins,tributosJson:tributosDevolucao(t)};
  });
  const sum = (fn:(t:TributacaoDevolucaoItem)=>number) => round2(ctx.refs.reduce((n,r)=>n+fn(r.tributacao),0));
  const tot = totaisDevolucao({itens,refs:ctx.refs,valorFrete:draft.valorFrete});
  return {...draft,itens,pagamentosJson:[{meio:"SEM_PAGAMENTO",valor:0}],duplicatasJson:null,notasReferenciadasJson:null,
    totaisJson:{totalProdutos:tot.totalProdutos,totalDesconto:tot.totalDesconto,totalFrete:tot.totalFrete,totalNota:tot.totalNota,
      totalBcIcms:tot.totalBcIcms,totalIcms:tot.totalIcms,totalBcIpi:0,totalIpi:0,totalPis:tot.totalPis,totalCofins:tot.totalCofins,totalTributos:sum(t=>t.icms.vICMS+t.pis.v+t.cofins.v)}};
}

/** Additive decorator; the legacy Focus builder and its snapshots stay unchanged. */
export function decorarFocusDevolucao(payload: Record<string,unknown>, ctx: ContextoEmissaoDevolucao): Record<string,unknown> {
  const result = structuredClone(payload);
  result.finalidade_emissao="4"; result.consumidor_final=ctx.indFinal;
  delete result.notas_referenciadas; delete result.cobranca; delete result.duplicatas;
  result.formas_pagamento=[{forma_pagamento:"90",valor_pagamento:"0.00"}];
  result.items=(Array.isArray(result.items)?result.items:[]).map((item:Record<string,unknown>,index:number)=>{
    const r=ctx.refs.find(ref=>ref.ordem===index+1);
    if (!r) throw new Error("Referência da devolução incompleta");
    const t=r.tributacao;
    // Nunca `pis_situacao_tributaria: null` para a Focus (ela escolheria por nós).
    if (!tributacaoEmitivel(t)) throw new Error("Tributação da devolução incompleta");
    const novo={...item,icms_situacao_tributaria:t.icms.csosn ?? t.icms.cst,icms_origem:t.icms.orig,
      icms_base_calculo:t.icms.vBC,icms_aliquota:t.icms.pICMS,icms_valor:t.icms.vICMS,
      pis_situacao_tributaria:t.pis.cst,pis_base_calculo:t.pis.vBC,pis_aliquota_porcentual:t.pis.p,pis_valor:t.pis.v,
      cofins_situacao_tributaria:t.cofins.cst,cofins_base_calculo:t.cofins.vBC,cofins_aliquota_porcentual:t.cofins.p,cofins_valor:t.cofins.v} as Record<string,unknown>;
    delete novo.chave_acesso_dfe_referenciado;delete novo.numero_item_dfe_referenciado;
    if(["ICMS00","ICMS90","ICMSSN900"].includes(t.icms.tag??""))novo.icms_modalidade_base_calculo=t.icms.modBC??"3";
    else for(const key of ["icms_modalidade_base_calculo","icms_base_calculo","icms_aliquota","icms_valor"])delete novo[key];
    if(ctx.modoReferencia==="ITEM") {novo.chave_acesso_dfe_referenciado=r.chaveAcessoOriginal;novo.numero_item_dfe_referenciado=r.nItemOriginal;}
    if(t.ipiDevol) {novo.percentual_devolvido=t.ipiDevol.pDevol;novo.valor_ipi_devolvido=t.ipiDevol.vIPIDevol;}
    return novo;
  });
  if(ctx.modoReferencia==="NOTA") result.notas_referenciadas=[...new Set(ctx.refs.map(r=>r.chaveAcessoOriginal))].map(chave_nfe=>({chave_nfe}));
  return result;
}

import type { NfeDraftResponse } from "../../interfaces/nfe.interface";
import type { NfeItemTributos, CstPisCofins } from "../domain/nfe.types";
import type { IndFinalDevolucao, ModoReferenciaDevolucao, RefDevolucaoItem, TributacaoDevolucaoItem } from "./tipos";
import { round2 } from "./tributacao";
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
export function calcularDevolucao(draft: NfeDraftResponse, ctx: ContextoEmissaoDevolucao): NfeDraftResponse {
  const itens = draft.itens.map((item,index) => {
    const t = ctx.refs.find(r=>r.ordem===index+1)?.tributacao;
    if (!t || !t.icms.tag || (t.requerRevisao && !t.confirmada)) throw new Error("Tributação da devolução incompleta");
    return {...item,numero:index+1,cstIcms:t.icms.csosn ?? t.icms.cst,cstPis:t.pis.cst as CstPisCofins,cstCofins:t.cofins.cst as CstPisCofins,tributosJson:tributosDevolucao(t)};
  });
  const sum = (fn:(t:TributacaoDevolucaoItem)=>number) => round2(ctx.refs.reduce((n,r)=>n+fn(r.tributacao),0));
  const totalProdutos=round2(itens.reduce((n,i)=>n+Number(i.valorTotal),0));
  const totalDesconto=round2(itens.reduce((n,i)=>n+Number(i.desconto ?? 0),0));
  const totalIpiDevol=sum(t=>t.ipiDevol?.vIPIDevol ?? 0);
  const totalFrete=isNfeFreteMedidasEnabled()?Number(draft.valorFrete ?? 0):0;
  return {...draft,itens,pagamentosJson:[{meio:"SEM_PAGAMENTO",valor:0}],duplicatasJson:null,notasReferenciadasJson:null,
    totaisJson:{totalProdutos,totalDesconto,totalFrete,totalNota:round2(totalProdutos-totalDesconto+totalFrete+totalIpiDevol),
      totalBcIcms:sum(t=>t.icms.vBC),totalIcms:sum(t=>t.icms.vICMS),totalBcIpi:0,totalIpi:0,totalPis:sum(t=>t.pis.v),totalCofins:sum(t=>t.cofins.v),totalTributos:sum(t=>t.icms.vICMS+t.pis.v+t.cofins.v)}};
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

import {afterEach,describe,expect,it,vi} from "vitest";
import {XMLParser} from "fast-xml-parser";
import {makeConfig,makeDraft} from "../__helpers__/test-draft";
import {CHAVE_ORIGINAL,CNF_FIXO,DH_EMI_FIXO} from "../golden/__fixtures__/casos-emissao";
import {NfeXmlBuilderSefazService} from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import {NfeXmlBuilderService} from "../../../app/fiscal/generators/nfe-xml-builder.service";
import {calcularDevolucao,decorarFocusDevolucao} from "../../../app/fiscal/devolucao/emissao";
import type {ContextoEmissaoDevolucao} from "../../../app/fiscal/devolucao/emissao";
import {montarRascunhoManual} from "../../../app/fiscal/devolucao/montagem-manual";
import {parseNfeXml} from "../../../app/fiscal/sefaz/nfe-xml-parser.service";

function contexto(modoReferencia:"ITEM"|"NOTA"):ContextoEmissaoDevolucao {
  return {modoReferencia,indFinal:"0",refs:[{ordem:1,chaveAcessoOriginal:CHAVE_ORIGINAL,nItemOriginal:2,tributacao:{versao:1,fonte:"USUARIO",icms:{tag:"ICMSSN900",cst:null,csosn:"900",orig:0,modBC:"3",vBC:100,pICMS:18,vICMS:18},pis:{cst:"49",vBC:100,p:1.65,v:1.65},cofins:{cst:"49",vBC:100,p:7.6,v:7.6},ipiDevol:{pDevol:50,vIPIDevol:5},requerRevisao:true,confirmada:true,motivosRevisao:[],avisos:[]}}]};
}
afterEach(()=>{vi.unstubAllEnvs();});
describe.each(["ITEM","NOTA"] as const)("emissão de devolução com referência %s",modo=>{
  it("XML contém apenas a referência adequada, pagamento 90 e IPI devolvido",()=>{
    const ctx=contexto(modo);const d=calcularDevolucao(makeDraft({finalidade:"DEVOLUCAO",tipoOperacao:"SAIDA",notasReferenciadasJson:[{chave:CHAVE_ORIGINAL}],duplicatasJson:[{numero:"1",valor:100}]}),ctx);
    const built=new NfeXmlBuilderSefazService().build({draft:d,config:makeConfig(),numero:1,cNF:CNF_FIXO,dhEmi:DH_EMI_FIXO,devolucao:ctx});
    const root=new XMLParser({ignoreAttributes:false,parseTagValue:false}).parse(built.xml).NFe.infNFe;
    expect(root.ide.finNFe).toBe("4");expect(root.ide.indFinal).toBe("0");expect(root.pag.detPag.tPag).toBe("90");expect(root.pag.detPag.vPag).toBe("0.00");expect(root.cobr).toBeUndefined();
    expect(root.det.imposto.ICMS.ICMSSN900.vICMS).toBe("18.00");expect(root.det.impostoDevol.IPI.vIPIDevol).toBe("5.00");expect(root.total.ICMSTot.vIPIDevol).toBe("5.00");
    if(modo==="ITEM"){expect(root.ide.NFref).toBeUndefined();expect(root.det.DFeReferenciado).toEqual({chaveAcesso:CHAVE_ORIGINAL,nItem:"2"});expect(Object.keys(root.det).filter(k=>!k.startsWith("@_")).at(-1)).toBe("DFeReferenciado");}
    else{expect(root.det.DFeReferenciado).toBeUndefined();expect(root.ide.NFref.refNFe).toBe(CHAVE_ORIGINAL);}
  });
  it("Focus recebe a mesma tributação, sem duplicatas nem referências duplicadas",()=>{
    const ctx=contexto(modo);const draft=calcularDevolucao(makeDraft({finalidade:"DEVOLUCAO"}),ctx);
    const payload=decorarFocusDevolucao(new NfeXmlBuilderService().build(draft,makeConfig(),1),ctx);
    expect(payload.formas_pagamento).toEqual([{forma_pagamento:"90",valor_pagamento:"0.00"}]);expect(payload.duplicatas).toBeUndefined();expect(payload.consumidor_final).toBe("0");
    const item=(payload.items as Record<string,unknown>[])[0];expect(item.icms_situacao_tributaria).toBe("900");expect(item.valor_ipi_devolvido).toBe(5);
    expect(Boolean(payload.notas_referenciadas)).toBe(modo==="NOTA");expect(Boolean(item.chave_acesso_dfe_referenciado)).toBe(modo==="ITEM");
  });
});
it("recusa tributação não revisada antes do builder",()=>{const ctx=contexto("ITEM");ctx.refs[0].tributacao.confirmada=false;expect(()=>calcularDevolucao(makeDraft(),ctx)).toThrow("incompleta");});
it("frete desligado mantém coerência entre total e XML",()=>{vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED","false");const d=calcularDevolucao(makeDraft({valorFrete:40}),contexto("NOTA"));expect(d.totaisJson?.totalFrete).toBe(0);});
it("manual sem XML mantém revisão obrigatória e vínculo pelo item original",()=>{
  const m=montarRascunhoManual({modo:"CHAVE",tipo:"COMPRA_SAIDA",companyFiscalConfigId:"cfg-test",devolvidaAposEntrega:null,escopo:"PARCIAL",chaveAcesso:CHAVE_ORIGINAL,confirmarSemXml:true,destinatario:null,itens:[{nItem:7,codigo:"X",descricao:"Peça",ncm:"87089990",unidade:"UN",quantidade:1,valorUnitario:10}]},makeConfig());
  expect(m.refs[0]).toMatchObject({nItemOriginal:7,quantidadeOriginal:null,tributacao:{requerRevisao:true,confirmada:false}});expect(m.cabecalho.pagamentosJson).toEqual([{meio:"SEM_PAGAMENTO",valor:0}]);expect(m.cabecalho).not.toHaveProperty("numero");
});
it("parser opt-in não altera a projeção legada",()=>{
  const b=new NfeXmlBuilderSefazService().build({draft:makeDraft(),config:makeConfig(),numero:1,cNF:CNF_FIXO,dhEmi:DH_EMI_FIXO});
  const legacy=parseNfeXml(b.xml);const next=parseNfeXml(b.xml,{devolucao:true});expect(legacy.ide).not.toHaveProperty("idDest");expect(next.ide.idDest).toBe(1);
  const {idDest,referencias,...ide}=next.ide;expect(ide).toEqual(legacy.ide);
});

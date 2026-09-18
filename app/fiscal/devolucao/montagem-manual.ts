import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { NfeDestinatario, NfeDraftItem } from "../../interfaces/nfe.interface";
import type { ManualValidado } from "./contrato";
import type { OrigemDevolucaoSnapshot, RefDevolucaoItem, TipoDevolucao, FonteDevolucao, EscopoDevolucao, IndFinalDevolucao, IdDest } from "./tipos";
import type { CabecalhoRascunhoDevolucao } from "./montagem";
import { parseChaveAcesso } from "../domain/chave-acesso-dv";
import { mapearCfopDevolucao } from "../domain/devolucao-cfop";
import { parseNfeXml } from "../sefaz/nfe-xml-parser.service";
import { crtDeRegime, normalizarImpostoOriginal, proporcionalizar, round2 } from "./tributacao";
import { DevolucaoError } from "./devolucao.errors";

export interface DevolucaoMontada {
  tipo: TipoDevolucao; fonte: FonteDevolucao; escopo: EscopoDevolucao; indFinal: IndFinalDevolucao;
  cabecalho: Omit<CabecalhoRascunhoDevolucao,"tipoOperacao"|"naturezaOperacao"> & {tipoOperacao:"ENTRADA"|"SAIDA";naturezaOperacao:string};
  itens: NfeDraftItem[]; refs: RefDevolucaoItem[]; origem: OrigemDevolucaoSnapshot;
}
function destXml(parsed: ReturnType<typeof parseNfeXml>, tipo: TipoDevolucao): NfeDestinatario {
  const d=tipo==="COMPRA_SAIDA" ? parsed.emit : parsed.dest;
  const ender=d.ender;
  return {tipoPessoa:d.CNPJ?"PJ":"PF",cpfCnpj:d.CNPJ??d.CPF??"",nome:d.xNome,inscricaoEstadual:d.IE,
    logradouro:ender?.xLgr,numero:ender?.nro,complemento:ender?.xCpl,bairro:ender?.xBairro,municipio:ender?.xMun,codMunicipio:ender?.cMun,uf:ender?.UF,cep:ender?.CEP,codPais:ender?.cPais,pais:ender?.xPais};
}
export function montarRascunhoManual(input: ManualValidado, config: CompanyFiscalConfig): DevolucaoMontada {
  let origem: OrigemDevolucaoSnapshot;
  let destinatario: NfeDestinatario | null;
  const digits=(s:string)=>s.replace(/\D/g,"");
  if(input.modo==="XML") {
    let parsed: ReturnType<typeof parseNfeXml>;
    try {parsed=parseNfeXml(input.xmlOriginal,{devolucao:true});} catch {throw new DevolucaoError("XML_INVALIDO");}
    const key=parseChaveAcesso(parsed.chaveAcesso);
    if(!key) throw new DevolucaoError("CHAVE_INVALIDA");
    if(!parsed.protNFe || ![100,150].includes(parsed.protNFe.cStat) || parsed.protNFe.chNFe!==key.chave) throw new DevolucaoError("XML_SEM_AUTORIZACAO");
    if(parsed.ide.tpAmb!==(config.ambiente==="PRODUCAO"?"1":"2")) throw new DevolucaoError("AMBIENTE_DIVERGENTE");
    const dono=input.tipo==="COMPRA_SAIDA" ? parsed.dest.CNPJ??parsed.dest.CPF??"" : parsed.emit.CNPJ??parsed.emit.CPF??"";
    if(digits(dono)!==digits(config.cnpj)) throw new DevolucaoError("NOTA_NAO_EMITIDA_PARA_ESTE_CNPJ");
    if(parsed.ide.finNFe==="4") throw new DevolucaoError("JA_E_DEVOLUCAO");
    destinatario=destXml(parsed,input.tipo);
    origem={chaveAcesso:key.chave,originalNfeId:null,modelo:key.modelo,numero:key.numero,serie:key.serie,dataEmissao:parsed.ide.dhEmi?.slice(0,10)??null,
      emitenteCnpjCpf:parsed.emit.CNPJ??parsed.emit.CPF??"",crtOriginal:parsed.emit.CRT,idDest:parsed.ide.idDest!,
      itens:parsed.itens.map(i=>({nItem:i.nItem,codigo:i.cProd,descricao:i.xProd,ncm:i.NCM,cest:i.CEST,unidade:i.uCom,cfop:i.CFOP,quantidade:i.qCom,valorUnitario:i.vUnCom,valorProduto:i.vProd,desconto:i.vDesc,origem:normalizarImpostoOriginal(i.imposto).icms?.orig??null,impostoOriginal:normalizarImpostoOriginal(i.imposto)}))};
  } else {
    const key=parseChaveAcesso(input.chaveAcesso);
    if(!key) throw new DevolucaoError("CHAVE_INVALIDA");
    destinatario=input.destinatario;
    const idDest: IdDest=destinatario?.uf && destinatario.uf!==config.uf ? 2:1;
    origem={chaveAcesso:key.chave,originalNfeId:null,modelo:key.modelo,numero:key.numero,serie:key.serie,dataEmissao:null,emitenteCnpjCpf:key.cnpjCpf,crtOriginal:null,idDest,
      itens:input.itens.map(i=>({nItem:i.nItem,codigo:i.codigo,descricao:i.descricao,ncm:i.ncm,cest:i.cest??null,unidade:i.unidade,cfop:i.cfopOriginal??"",quantidade:i.quantidadeOriginal??0,valorUnitario:i.valorUnitario,valorProduto:round2(i.valorUnitario*(i.quantidadeOriginal??i.quantidade)),desconto:0,origem:i.origem??null,impostoOriginal:normalizarImpostoOriginal(null)}))};
  }
  const itens:NfeDraftItem[]=[];const refs:RefDevolucaoItem[]=[];
  const crt=crtDeRegime(config.regimeTributario);
  for(const original of origem.itens) {
    const selecionado=input.itens?.find(i=>i.nItem===original.nItem);
    if(input.itens && !selecionado) continue;
    const quantidade=selecionado?.quantidade??original.quantidade;
    if(quantidade<=0) continue;
    if(original.quantidade>0 && quantidade>original.quantidade) throw new DevolucaoError("SALDO_INSUFICIENTE");
    const ordem=itens.length+1;
    const cfopMapeamento=mapearCfopDevolucao({cfopOriginal:original.cfop,tipo:input.tipo,idDestOriginal:origem.idDest,crt});
    const cfop=selecionado && "cfop" in selecionado && typeof selecionado.cfop === "string" ? selecionado.cfop:cfopMapeamento.cfop??"";
    const valor=round2(quantidade*original.valorUnitario);
    const imposto=input.modo==="XML"?original.impostoOriginal:null;
    const tributacao=proporcionalizar({impostoOriginal:imposto,qOriginal:original.quantidade||null,qDevolvida:quantidade,vUnCom:original.valorUnitario,crtEmitente:crt,crtOriginal:origem.crtOriginal,tipoOperacao:input.tipo==="COMPRA_SAIDA"?"SAIDA":"ENTRADA"});
    itens.push({numero:ordem,productId:null,codigo:original.codigo,descricao:original.descricao,ncm:original.ncm,cest:original.cest,unidade:original.unidade,origem:(original.origem??0) as NfeDraftItem["origem"],cfop,quantidade,valorUnitario:original.valorUnitario,valorTotal:valor,desconto:original.quantidade?round2(original.desconto*quantidade/original.quantidade):0});
    refs.push({ordem,originalNfeId:null,chaveAcessoOriginal:origem.chaveAcesso,nItemOriginal:original.nItem,codigoOriginal:original.codigo,cfopOriginal:original.cfop,quantidadeOriginal:original.quantidade||null,valorUnitarioOriginal:original.valorUnitario,quantidade,valor,impostoOriginal:imposto,tributacao,cfopMapeamento});
  }
  if(!itens.length) throw new DevolucaoError("PAYLOAD_INVALIDO");
  return {tipo:input.tipo,fonte:input.modo==="XML"?"XML_IMPORTADO":"MANUAL",escopo:input.escopo??"TOTAL",indFinal:input.tipo==="COMPRA_SAIDA"?"0":"1",origem,itens,refs,
    cabecalho:{tipoOperacao:input.tipo==="COMPRA_SAIDA"?"SAIDA":"ENTRADA",finalidade:"DEVOLUCAO",modelo:"55",destinoOperacao:({1:"INTERNA",2:"INTERESTADUAL",3:"EXTERIOR"} as const)[origem.idDest],
      indPresenca:"NAO_SE_APLICA",modalidadeFrete:"SEM_FRETE",pagamentosJson:[{meio:"SEM_PAGAMENTO",valor:0}],duplicatasJson:null,notasReferenciadasJson:null,
      naturezaOperacao:input.tipo==="COMPRA_SAIDA"?"DEVOLUCAO DE COMPRA":"DEVOLUCAO DE VENDA",informacoesComplementares:`Devolucao ref. NF-e ${origem.numero} serie ${origem.serie}, chave ${origem.chaveAcesso}`,
      serie:config.serieNfe,ambiente:config.ambiente,companyFiscalConfigId:config.id,customerId:null,destinatarioJson:destinatario}};
}

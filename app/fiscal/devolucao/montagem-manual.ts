import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { NfeDestinatario, NfeDraftItem } from "../../interfaces/nfe.interface";
import { conferirChaveDevolucaoManual, type ManualValidado } from "./contrato";
import type { OrigemDevolucaoSnapshot, OrigemItemSnapshot, RefDevolucaoItem, TipoDevolucao, FonteDevolucao, EscopoDevolucao, IndFinalDevolucao, IdDest, CrtEmitente, DevolucaoIssue, SaldoItemOriginal, TributacaoDevolucaoItem } from "./tipos";
import type { CabecalhoRascunhoDevolucao } from "./montagem";
import { parseChaveAcesso } from "../domain/chave-acesso-dv";
import { mapearCfopDevolucao } from "../domain/devolucao-cfop";
import { parseNfeXml } from "../sefaz/nfe-xml-parser.service";
import { crtDeRegime, normalizarImpostoOriginal, proporcionalizar, round2 } from "./tributacao";
import { DevolucaoError } from "./devolucao.errors";
import { calcularSaldoPorItem, escopoDaDevolucao, issueSaldoExcedido, quantidadeOriginalDoLivro, quantidadeParaUnidades, temDevolucaoConsumindo, unidadesParaQuantidade, type LinhaSaldoDevolucao } from "./saldo";

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
/** A nota original como a devolução manual a conhece (XML lido ou chave + itens digitados). */
export interface OrigemManualLida { origem: OrigemDevolucaoSnapshot; destinatario: NfeDestinatario | null }

export interface OpcoesMontagemManual {
  /**
   * Saldo por nItem da original, do livro de devoluções (o caso de uso calcula sob o
   * lock da chave). Ausente = só a nota original conta (nenhuma devolução anterior).
   */
  saldos?: ReadonlyArray<SaldoItemOriginal> | null;
  /** Origem já lida por `lerOrigemManual` (evita reler o XML dentro da transação). */
  lida?: OrigemManualLida | null;
}

/**
 * O imposto de partida de UM item da devolução — a MESMA conta na criação manual e no
 * PUT dos itens (antes eram duas cópias do `proporcionalizar`, e uma esquecia o desconto):
 * - o desconto é o da linha na proporção devolvida (o mesmo que vai ao NfeItem), e a base
 *   que nasce do item fica LÍQUIDA dele;
 * - na devolução pela chave (fonte MANUAL) não há imposto original, mas a origem da
 *   mercadoria que ela informou vai para o ICMS — sem isso o XML dizia `<orig>0</orig>`
 *   (nacional) para qualquer peça, inclusive importada.
 */
export function baseTributariaDoItem(e: {
  fonte: FonteDevolucao;
  original: Pick<OrigemItemSnapshot, "quantidade" | "valorUnitario" | "desconto" | "origem" | "impostoOriginal">;
  /** qCom da original; 0/null = desconhecida. */
  quantidadeOriginal: number | null;
  quantidade: number;
  crtEmitente: CrtEmitente | null;
  crtOriginal: string | null;
  tipo: TipoDevolucao;
}): { tributacao: TributacaoDevolucaoItem; valor: number; desconto: number; baseCalculo: number } {
  const qOrig = e.quantidadeOriginal && e.quantidadeOriginal > 0 ? e.quantidadeOriginal : null;
  const valor = round2(e.quantidade * e.original.valorUnitario);
  const desconto = e.original.quantidade ? round2(e.original.desconto * e.quantidade / e.original.quantidade) : 0;
  const tributacao = proporcionalizar({
    impostoOriginal: e.fonte === "MANUAL" ? null : e.original.impostoOriginal,
    qOriginal: qOrig,
    qDevolvida: e.quantidade,
    vUnCom: e.original.valorUnitario,
    crtEmitente: e.crtEmitente,
    crtOriginal: e.crtOriginal,
    tipoOperacao: e.tipo === "COMPRA_SAIDA" ? "SAIDA" : "ENTRADA",
    descontoDevolvido: desconto,
  });
  const orig = e.original.origem;
  if (e.fonte === "MANUAL" && tributacao.icms.orig === null && typeof orig === "number" && Number.isInteger(orig) && orig >= 0 && orig <= 8) {
    tributacao.icms.orig = orig;
  }
  return { tributacao, valor, desconto, baseCalculo: Math.max(0, round2(valor - desconto)) };
}

/**
 * Completa a origem da devolução manual com o que o Dexo JÁ sabe da nota:
 * - o vínculo com a nota do próprio Dexo (`originalNfeId`), na devolução de venda;
 * - na devolução pela CHAVE, a quantidade original de cada item: primeiro a que uma
 *   devolução montada do XML já gravou (livro), depois a do NfeItem da nota do Dexo
 *   (mesmo nº e mesmo código), e só então a digitada. Sem ela o saldo ficava
 *   "não verificável" e a mesma peça podia ser devolvida de novo.
 * No modo XML as quantidades são as do próprio XML e não mudam.
 */
export function completarOrigemManual(lida: OrigemManualLida, e: {
  modo: "XML" | "CHAVE";
  linhas: ReadonlyArray<LinhaSaldoDevolucao>;
  notaOriginal?: { id: string; itens: ReadonlyArray<{ numero: number; codigo: string; quantidade: number | string }> } | null;
}): OrigemManualLida {
  const origem = lida.origem;
  const originalNfeId = e.notaOriginal?.id ?? origem.originalNfeId;
  const itens = e.modo === "XML" ? origem.itens : origem.itens.map((i) => {
    const doLivro = quantidadeOriginalDoLivro(e.linhas, origem.chaveAcesso, i.nItem);
    const nfeItem = e.notaOriginal?.itens.find((n) => n.numero === i.nItem && n.codigo === i.codigo);
    const daNota = nfeItem ? Number(nfeItem.quantidade) : null;
    const quantidade = doLivro ?? (daNota !== null && Number.isFinite(daNota) && daNota > 0 ? daNota : null) ?? i.quantidade;
    return quantidade === i.quantidade ? i : { ...i, quantidade, valorProduto: round2(i.valorUnitario * quantidade) };
  });
  if (originalNfeId === origem.originalNfeId && itens === origem.itens) return lida;
  return { ...lida, origem: { ...origem, originalNfeId, itens } };
}

/** Lê a nota original da devolução manual: o XML autorizado, ou a chave com os itens digitados. */
export function lerOrigemManual(input: ManualValidado, config: CompanyFiscalConfig): OrigemManualLida {
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
    // Destino da operação e UF do fornecedor pela CHAVE (conferirChaveDevolucaoManual), não
    // pela UF digitada: na devolução de compra "sc" minúsculo ou a UF errada viravam
    // operação interestadual presa no rascunho. As recusas dela o caso de uso já devolveu
    // (400) antes de chegar aqui; sem destino conhecido fica a regra antiga.
    const conferencia=conferirChaveDevolucaoManual({tipo:input.tipo,chaveAcesso:key.chave,destinatario:input.destinatario,itens:input.itens,emitente:{cnpj:config.cnpj,uf:config.uf}});
    destinatario=input.destinatario;
    if(destinatario && input.tipo==="COMPRA_SAIDA" && conferencia.ufDestinatario) destinatario={...destinatario,uf:conferencia.ufDestinatario};
    const idDest: IdDest=conferencia.idDest ?? (destinatario?.uf && destinatario.uf!==config.uf ? 2:1);
    origem={chaveAcesso:key.chave,originalNfeId:null,modelo:key.modelo,numero:key.numero,serie:key.serie,dataEmissao:null,emitenteCnpjCpf:key.cnpjCpf,crtOriginal:null,idDest,
      itens:input.itens.map(i=>({nItem:i.nItem,codigo:i.codigo,descricao:i.descricao,ncm:i.ncm,cest:i.cest??null,unidade:i.unidade,cfop:i.cfopOriginal??"",quantidade:i.quantidadeOriginal??0,valorUnitario:i.valorUnitario,valorProduto:round2(i.valorUnitario*(i.quantidadeOriginal??i.quantidade)),desconto:0,origem:i.origem??null,impostoOriginal:normalizarImpostoOriginal(null)}))};
  }
  return {origem,destinatario};
}

/**
 * Monta a devolução manual (XML do fornecedor/cliente, ou chave + itens).
 *
 * Quantidade: com a seleção (`input.itens`), a pedida; sem ela, o que AINDA pode ser
 * devolvido de cada item (`saldos`), e item sem saldo fica de fora — era o qCom cheio,
 * e a segunda devolução da mesma nota do fornecedor não nascia ("Quantidade maior que
 * o saldo"). Nenhum item com saldo ⇒ TOTALMENTE_DEVOLVIDA.
 *
 * Escopo: DERIVADO dos itens (`escopoDaDevolucao`), nunca o pedido — a tela manual
 * nunca manda escopo, e o padrão "TOTAL" travava qualquer edição parcial depois.
 * "TOTAL" pedido numa nota já parcialmente devolvida é recusado como em "Devolver total".
 */
export function montarRascunhoManual(input: ManualValidado, config: CompanyFiscalConfig, opcoes?: OpcoesMontagemManual): DevolucaoMontada {
  const {origem,destinatario}=opcoes?.lida ?? lerOrigemManual(input,config);
  const saldos=opcoes?.saldos ?? calcularSaldoPorItem({itensOriginais:origem.itens.map(i=>({nItem:i.nItem,quantidade:i.quantidade||null})),linhas:[]});
  if(input.escopo==="TOTAL" && temDevolucaoConsumindo(saldos)) throw new DevolucaoError("PARCIALMENTE_DEVOLVIDA");
  const saldoDe=new Map(saldos.map(s=>[s.nItem,s]));
  const itens:NfeDraftItem[]=[];const refs:RefDevolucaoItem[]=[];const excedidos:DevolucaoIssue[]=[];
  const crt=crtDeRegime(config.regimeTributario);
  const fonte:FonteDevolucao=input.modo==="XML"?"XML_IMPORTADO":"MANUAL";
  let semSaldo=0;
  for(const original of origem.itens) {
    const selecionado=input.itens?.find(i=>i.nItem===original.nItem);
    if(input.itens && !selecionado) continue;
    const saldo=saldoDe.get(original.nItem)??null;
    const dispU=saldo && saldo.disponivel!==null ? quantidadeParaUnidades(saldo.disponivel) : null;
    let quantidade:number;
    if(selecionado) quantidade=selecionado.quantidade;
    else if(dispU!==null) { if(dispU<=0){semSaldo++;continue;} quantidade=unidadesParaQuantidade(dispU); }
    else quantidade=original.quantidade;
    if(quantidade<=0) continue;
    const ordem=itens.length+1;
    const qU=quantidadeParaUnidades(quantidade)??0;
    const qOrigU=original.quantidade>0?quantidadeParaUnidades(original.quantidade):null;
    if((dispU!==null && qU>dispU) || (dispU===null && qOrigU!==null && qU>qOrigU)) {
      excedidos.push(issueSaldoExcedido({ordem,nItemOriginal:original.nItem,codigo:original.codigo,pedida:quantidade,saldo,quantidadeOriginal:original.quantidade||null}));
      continue;
    }
    const cfopMapeamento=mapearCfopDevolucao({cfopOriginal:original.cfop,tipo:input.tipo,idDestOriginal:origem.idDest,crt});
    const cfop=selecionado && "cfop" in selecionado && typeof selecionado.cfop === "string" ? selecionado.cfop:cfopMapeamento.cfop??"";
    const imposto=input.modo==="XML"?original.impostoOriginal:null;
    const {tributacao,valor,desconto}=baseTributariaDoItem({fonte,original,quantidadeOriginal:original.quantidade||null,quantidade,crtEmitente:crt,crtOriginal:origem.crtOriginal,tipo:input.tipo});
    itens.push({numero:ordem,productId:null,codigo:original.codigo,descricao:original.descricao,ncm:original.ncm,cest:original.cest,unidade:original.unidade,origem:(original.origem??0) as NfeDraftItem["origem"],cfop,quantidade,valorUnitario:original.valorUnitario,valorTotal:valor,desconto});
    refs.push({ordem,originalNfeId:origem.originalNfeId,chaveAcessoOriginal:origem.chaveAcesso,nItemOriginal:original.nItem,codigoOriginal:original.codigo,cfopOriginal:original.cfop,quantidadeOriginal:original.quantidade||null,valorUnitarioOriginal:original.valorUnitario,quantidade,valor,impostoOriginal:imposto,tributacao,cfopMapeamento});
  }
  if(excedidos.length) throw new DevolucaoError("SALDO_INSUFICIENTE",excedidos);
  if(!itens.length) throw new DevolucaoError(semSaldo>0?"TOTALMENTE_DEVOLVIDA":"PAYLOAD_INVALIDO");
  const escopo:EscopoDevolucao=escopoDaDevolucao({saldos,itens:refs.map(r=>({nItem:r.nItemOriginal,quantidade:r.quantidade}))});
  return {tipo:input.tipo,fonte,escopo,indFinal:input.tipo==="COMPRA_SAIDA"?"0":"1",origem,itens,refs,
    cabecalho:{tipoOperacao:input.tipo==="COMPRA_SAIDA"?"SAIDA":"ENTRADA",finalidade:"DEVOLUCAO",modelo:"55",destinoOperacao:({1:"INTERNA",2:"INTERESTADUAL",3:"EXTERIOR"} as const)[origem.idDest],
      indPresenca:"NAO_SE_APLICA",modalidadeFrete:"SEM_FRETE",pagamentosJson:[{meio:"SEM_PAGAMENTO",valor:0}],duplicatasJson:null,notasReferenciadasJson:null,
      naturezaOperacao:input.tipo==="COMPRA_SAIDA"?"DEVOLUCAO DE COMPRA":"DEVOLUCAO DE VENDA",informacoesComplementares:`Devolucao ref. NF-e ${origem.numero} serie ${origem.serie}, chave ${origem.chaveAcesso}`,
      serie:config.serieNfe,ambiente:config.ambiente,companyFiscalConfigId:config.id,customerId:null,destinatarioJson:destinatario}};
}

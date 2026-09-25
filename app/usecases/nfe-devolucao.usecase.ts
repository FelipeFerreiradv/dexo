import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { NfeDevolucaoRepository } from "../fiscal/devolucao/devolucao.repository";
import type { DevolucaoPersistida, FiscalSql } from "../fiscal/devolucao/devolucao.repository";
import { DevolucaoError } from "../fiscal/devolucao/devolucao.errors";
import { NumeracaoError } from "../fiscal/numeracao/numeracao.errors";
import { isDevolucaoAtiva, isNumeracaoV2ParaEmissao, devolucaoRefItemProdDesde } from "../fiscal/flags";
import { FiscalStorageService } from "../fiscal/storage/fiscal-storage.service";
import { parseNfeXml } from "../fiscal/sefaz/nfe-xml-parser.service";
import { montarRascunhoDeOriginal } from "../fiscal/devolucao/montagem";
import { baseTributariaDoItem, completarOrigemManual, lerOrigemManual, montarRascunhoManual } from "../fiscal/devolucao/montagem-manual";
import type { OrigemManualLida } from "../fiscal/devolucao/montagem-manual";
import { calcularSaldoPorItem, escopoDaDevolucao, issueSaldoExcedido, itensOriginaisComLivro, quantidadeOriginalDoLivro, quantidadeParaUnidades, unidadesParaQuantidade } from "../fiscal/devolucao/saldo";
import type { LinhaSaldoDevolucao } from "../fiscal/devolucao/saldo";
import type { NfeStatus } from "../fiscal/domain/nfe.types";
import { crtDeRegime, aplicarOverrideTributacao, referenciaImpostoOriginal, regimeEmitenteDevolucao } from "../fiscal/devolucao/tributacao";
import { mapearCfopDevolucao, isCfopPermitidoEmDevolucao, idDestDoCfop } from "../fiscal/domain/devolucao-cfop";
import { validarDevolucao, temBloqueio } from "../fiscal/devolucao/validacao";
import { modoReferenciaDevolucao } from "../fiscal/devolucao/modo-referencia";
import { conferirChaveDevolucaoManual } from "../fiscal/devolucao/contrato";
import type { AtualizarCabecalhoBody, AtualizarItensBody, CriarDevolucaoBody, DevolucaoAbertaResumo, DevolucaoDetalhe, DevolucaoErroCodigo, DevolucaoItemDetalhe, DisponibilidadeDevolucaoResposta, ManualValidado, OutraDevolucaoDoItem, PreviaDevolucaoManual, SaldoResposta } from "../fiscal/devolucao/contrato";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";
import type { NfeDraftItem } from "../interfaces/nfe.interface";
import type { DevolucaoIssue, EscopoDevolucao, OrigemDevolucaoSnapshot, RefDevolucaoItem, SaldoItemOriginal, TributacaoOverride } from "../fiscal/devolucao/tipos";
import { totaisDevolucao } from "../fiscal/devolucao/emissao";
import type { ContextoEmissaoDevolucao } from "../fiscal/devolucao/emissao";
import { hashConteudo } from "../fiscal/numeracao/decisao";
import { createNfeProvider } from "../fiscal/providers/provider-factory";
import { FocusNfeProvider } from "../fiscal/providers/focus-nfe.provider";
import { NfeNumeracaoService } from "../fiscal/numeracao/numeracao.service";

type SaldoComChave = SaldoItemOriginal & {chaveAcesso:string};

/** Quanto vale a lista de donos das configs com a devolução ligada (`donosComDevolucao`). */
const DONOS_COM_DEVOLUCAO_TTL_MS=10*60_000;

/**
 * O ajuste salvo (`saved`) + o que veio no corpo, CAMPO a campo: o que o corpo não
 * traz fica com o valor GRAVADO — que é o que a tela mostra —, nunca com o do XML
 * do fornecedor.
 * - Tributo ausente do corpo: o salvo inteiro (era `b.tributacao ?? saved`: salvar só
 *   o ICMS refazia PIS/COFINS a partir do XML — DLS, 24/09 18:24).
 * - ICMS: o PAR cst/csosn é atômico — se o corpo traz um dos dois, os dois vêm do corpo
 *   (o que faltar é null); {cst} novo sobre {csosn} salvo deixaria os dois preenchidos e o
 *   CSOSN venceria a escolha dela. Modalidade e alíquota ausentes = as gravadas: escolher
 *   de novo o 900 sem digitar a alíquota mantinha na tela os 0% gravados e salvava os 12%
 *   do fornecedor.
 * - PIS/COFINS: CST e alíquota ausentes = os gravados (o CST 01 reenviado sem `p` voltava
 *   a 0%, herdado do 04 do fornecedor, com a tela mostrando 1,65%).
 */
export function mesclarAjusteTributacao(saved:TributacaoOverride|undefined,corpo:TributacaoOverride|undefined):TributacaoOverride|undefined {
  if(!saved)return corpo;
  if(!corpo)return saved;
  const out:TributacaoOverride={...saved};
  if(corpo.icms) {
    const trocaCodigo=corpo.icms.cst!==undefined || corpo.icms.csosn!==undefined;
    out.icms={cst:trocaCodigo?corpo.icms.cst??null:saved.icms?.cst??null,csosn:trocaCodigo?corpo.icms.csosn??null:saved.icms?.csosn??null,
      modBC:corpo.icms.modBC??saved.icms?.modBC??null,pICMS:corpo.icms.pICMS??saved.icms?.pICMS??null};
  }
  for(const qual of ["pis","cofins"] as const) {
    const c=corpo[qual];if(!c)continue;
    out[qual]={cst:c.cst!==undefined?c.cst:saved[qual]?.cst??null,p:c.p??saved[qual]?.p??null};
  }
  if(corpo.ipiDevol!==undefined)out.ipiDevol=corpo.ipiDevol;
  return out;
}

/**
 * Recusa de CFOP de UM item, com o item e o CFOP (antes: "CFOP inválido para esta
 * devolução.", sem dizer qual). As MESMAS duas condições de antes — nada passa a ser
 * aceito ou recusado de outro jeito; só a recusa ganha item, código e frase.
 */
function issueCfop(ordem:number,cfop:string,tpNF:"0"|"1",idDestOriginal:number):DevolucaoIssue|null {
  if(!isCfopPermitidoEmDevolucao(cfop,tpNF)) {
    return {code:"CFOP_NAO_DEVOLUCAO",severidade:"ERRO",ordem,mensagem:`Item ${ordem}: o CFOP ${cfop} não é de devolução para esta operação (Rejeição 327).`};
  }
  if(idDestDoCfop(cfop)!==idDestOriginal) {
    const onde=idDestOriginal===1?"dentro do estado":idDestOriginal===2?"para outro estado":"para o exterior";
    return {code:"CFOP_IDDEST_DIVERGENTE",severidade:"ERRO",ordem,mensagem:`Item ${ordem}: o CFOP ${cfop} não combina com o destino da operação, que é ${onde}.`};
  }
  return null;
}

/**
 * Onde mais este item da nota original está: outros rascunhos (não seguram saldo, mas o
 * primeiro a sair zera os outros) e devoluções autorizadas/em envio. Sem canceladas nem
 * inutilizadas, e sem a própria devolução. Rascunho não tem nº fiscal (placeholder
 * negativo) ⇒ `numero: null`.
 */
function outrasDevolucoesDoItem(linhas:ReadonlyArray<LinhaSaldoDevolucao>|undefined,nItem:number,propriaNfeId:string):OutraDevolucaoDoItem[] {
  return (linhas??[]).filter(l=>l.nItem===nItem && l.devolucaoNfeId!==propriaNfeId && !["CANCELLED","INUTILIZED"].includes(l.statusDevolucao))
    .map(l=>({nfeId:l.devolucaoNfeId,status:l.statusDevolucao,numero:typeof l.numeroDevolucao==="number" && l.numeroDevolucao>0?l.numeroDevolucao:null,serie:l.serieDevolucao??null,quantidade:Number(l.quantidade),criadaEm:l.criadaEm==null?null:new Date(l.criadaEm).toISOString()}));
}

/**
 * K6(3): devolução de VENDA pela CHAVE de uma nota do PRÓPRIO Dexo que tem o XML autorizado
 * guardado é recusada (ORIGINAL_TEM_XML_NO_DEXO, com o caminho certo na frase): pela nota
 * ("Devolver") o imposto e o saldo de cada peça saem do XML autorizado; pela chave a
 * devolução nasce das peças digitadas, sem o imposto da nota. Nota sem XML guardado (as
 * 447 do histórico importado da DLS) continua podendo ir pela chave. Só o modo CHAVE: o
 * modo XML já lê o próprio XML.
 */
function recusarChaveDeNotaComXml(input:ManualValidado,nota:{xmlAutorizadoPath:string|null}|null):void {
  if(input.modo==="CHAVE" && input.tipo==="VENDA_ENTRADA" && typeof nota?.xmlAutorizadoPath==="string" && nota.xmlAutorizadoPath.trim()!=="")throw new DevolucaoError("ORIGINAL_TEM_XML_NO_DEXO");
}

/** A tela da devolução manual digita os mesmos itens de novo? (mesmos dados fixos da nota original) */
function mesmosItensDigitados(input:ManualValidado,origem:OrigemDevolucaoSnapshot):boolean {
  if(input.modo!=="CHAVE")return true;
  return input.itens.every(i=>{
    const o=origem.itens.find(x=>x.nItem===i.nItem);
    return !!o && o.codigo===i.codigo && o.descricao===i.descricao && o.ncm===i.ncm && o.unidade===i.unidade && (o.cest??null)===(i.cest??null)
      && o.cfop===(i.cfopOriginal??"") && o.valorUnitario===i.valorUnitario && (o.origem??null)===(i.origem??null);
  });
}

/**
 * `DevolucaoAbertaResumo` (rascunho de devolução em aberto, para "Continuar"/"Descartar")
 * e `PreviaDevolucaoManual` (a prévia da devolução manual, sem criar nada) moram no
 * CONTRATO, para o front importar sem puxar código de servidor; daqui só reexportados
 * (quem importava deste arquivo continua importando).
 */
export type { DevolucaoAbertaResumo, PreviaDevolucaoManual } from "../fiscal/devolucao/contrato";

/**
 * Recusa de cancelar a nota ORIGINAL que tem devolução autorizada ou em envio, citando
 * CADA devolução (antes: "A nota tem devolução autorizada ou em envio — cancele a
 * devolução antes.", sem dizer qual). Recebe as linhas do livro (`linhasSaldo` da chave
 * da original) e decide com a MESMA regra de antes: status AUTHORIZED ou em envio
 * (VALIDATING/SIGNING/SENDING). `null` = nada impede o cancelamento.
 *
 * Uma issue por devolução, com o id e o nº fiscal dela (`devolucaoNfeId`,
 * `numeroDevolucao`, `serieDevolucao`). Rascunho/em envio não tem nº fiscal
 * (placeholder negativo) ⇒ `numeroDevolucao: null`.
 */
export function erroOriginalComDevolucao(linhas:ReadonlyArray<LinhaSaldoDevolucao>):DevolucaoError|null {
  const EM_ENVIO=["VALIDATING","SIGNING","SENDING"];
  const vistas=new Map<string,LinhaSaldoDevolucao>();
  for(const l of linhas)if((l.statusDevolucao==="AUTHORIZED" || EM_ENVIO.includes(l.statusDevolucao)) && !vistas.has(l.devolucaoNfeId))vistas.set(l.devolucaoNfeId,l);
  if(!vistas.size)return null;
  const numeroDe=(l:LinhaSaldoDevolucao)=>typeof l.numeroDevolucao==="number" && l.numeroDevolucao>0?l.numeroDevolucao:null;
  const issues=[...vistas.values()].map((l):DevolucaoIssue=>{
    const numero=numeroDe(l);const serie=l.serieDevolucao??null;
    const nome=numero!==null?`a NF-e de devolução nº ${numero}${serie!==null?` (série ${serie})`:""}`:"uma NF-e de devolução";
    return l.statusDevolucao==="AUTHORIZED"
      ?{code:"PARCIALMENTE_DEVOLVIDA",severidade:"ERRO",devolucaoNfeId:l.devolucaoNfeId,numeroDevolucao:numero,serieDevolucao:serie,
        mensagem:`Esta nota tem ${nome} autorizada. Cancele primeiro a devolução (em "Notas Emitidas") e depois esta nota.`}
      :{code:"EMISSAO_EM_ANDAMENTO",severidade:"ERRO",devolucaoNfeId:l.devolucaoNfeId,numeroDevolucao:numero,serieDevolucao:serie,
        mensagem:`Esta nota tem ${nome} sendo enviada à SEFAZ. Espere o resultado dela: se for autorizada, cancele-a antes; se for recusada, esta nota pode ser cancelada.`};
  });
  return new DevolucaoError("ORIGINAL_COM_DEVOLUCAO",issues,{mensagem:issues.map(i=>i.mensagem).join(" ")});
}

export class NfeDevolucaoUseCase {
  constructor(readonly repo=new NfeDevolucaoRepository(),private readonly configs=new CompanyFiscalRepository(),private readonly storage=new FiscalStorageService()) {}
  private async config(userId:string,id?:string|null):Promise<CompanyFiscalConfig> {
    const c=id?await this.configs.findByIdForUser(id,userId):await this.configs.findByUserId(userId);
    if(!c || !isDevolucaoAtiva(c.id))throw new NumeracaoError("RECURSO_INDISPONIVEL",404,"Recurso indisponível");
    if(!isNumeracaoV2ParaEmissao(c.id,"55",c.providerName))throw new DevolucaoError("EXIGE_NUMERACAO_V2");
    return c;
  }
  private async original(userId:string,id:string) {
    const n=await this.repo.nota(userId,id);if(!n)throw new DevolucaoError("NAO_ENCONTRADA");
    const c=await this.config(userId,n.companyFiscalConfigId);
    if(n.status==="CANCELLED")throw new DevolucaoError("CANCELADA");
    if(n.status!=="AUTHORIZED")throw new DevolucaoError("NAO_AUTORIZADA");
    if(n.finalidade==="DEVOLUCAO")throw new DevolucaoError("JA_E_DEVOLUCAO");
    if(n.tipoOperacao!=="SAIDA")throw new DevolucaoError("ORIGINAL_ENTRADA");
    if(!["55","65"].includes(n.modelo))throw new DevolucaoError("MODELO_NAO_SUPORTADO");
    let xml=n.xmlAutorizadoPath?await this.storage.readFile(n.xmlAutorizadoPath):null;
    if(!xml && c.providerName!=="SEFAZ_DIRECT" && c.providerToken) {
      const ref=(await new NfeNumeracaoService().focusRefAutorizada(userId,id))??id;
      const provider=createNfeProvider(c.providerName,c.ambiente,{modelo:n.modelo==="65"?"65":"55"});
      const fetched=provider instanceof FocusNfeProvider?await provider.buscarXml(ref,c.providerToken):null;
      if(fetched)xml=Buffer.from(fetched,"utf8");
    }
    if(!xml)throw new DevolucaoError("SEM_XML");
    let parsed:ReturnType<typeof parseNfeXml>;
    try{parsed=parseNfeXml(xml.toString("utf8"),{devolucao:true});}catch{throw new DevolucaoError("XML_INVALIDO");}
    if(!parsed.protNFe || ![100,150].includes(parsed.protNFe.cStat) || parsed.protNFe.chNFe!==parsed.chaveAcesso)throw new DevolucaoError("XML_SEM_AUTORIZACAO");
    return {n,c,parsed};
  }
  async criar(userId:string,actorUserId:string,id:string,body:CriarDevolucaoBody) {
    const {n,c,parsed}=await this.original(userId,id);
    return this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,[parsed.chaveAcesso]);
      const atual=await this.repo.nota(userId,id,tx);
      if(atual?.status!=="AUTHORIZED")throw new DevolucaoError("NAO_AUTORIZADA");
      const aberta=await this.repo.aberta(userId,parsed.chaveAcesso,tx,"VENDA_ENTRADA");
      // Reaproveita SEM mexer no escopo dela (apertar para "total" pularia a recusa de nota
      // já parcialmente devolvida). Devolve o escopo que ela tem, para a tela avisar que
      // abriu a devolução que já existia — e qual.
      if(aberta)return {draftId:aberta,reutilizado:true,escopo:(await this.repo.escopoDe(userId,aberta,tx))??undefined};
      const linhasSaldo=await this.repo.linhasSaldo(userId,parsed.chaveAcesso,tx);
      const m=montarRascunhoDeOriginal({original:{...n,companyFiscalConfigId:n.companyFiscalConfigId??null},config:c,parsed,idDestOriginal:parsed.ide.idDest!,linhasSaldo,
        itensNfe:n.itens.map(i=>({...i,productId:i.productId??null})),escopo:body.escopo??"TOTAL",tipo:"VENDA_ENTRADA"});
      const erro=m.issues.find(i=>i.severidade==="ERRO" && ["CHAVE_DIVERGENTE","AMBIENTE_DIVERGENTE","TOTALMENTE_DEVOLVIDA","PARCIALMENTE_DEVOLVIDA","EMITENTE_ORIGINAL_DIVERGENTE"].includes(i.code));
      if(erro)throw new DevolucaoError(erro.code==="TOTALMENTE_DEVOLVIDA"?"TOTALMENTE_DEVOLVIDA":erro.code==="PARCIALMENTE_DEVOLVIDA"?"PARCIALMENTE_DEVOLVIDA":"DEVOLUCAO_INVALIDA",[erro]);
      if(!m.itens.length)throw new DevolucaoError("TOTALMENTE_DEVOLVIDA");
      // O escopo GRAVADO é o derivado das quantidades (escopoDaDevolucao), como em itens() e
      // cabecalho(): "Devolver parcial" nasce com TODAS as peças e a quantidade cheia de cada
      // uma, e gravar o pedido ("PARCIAL") deixava o rascunho dizendo "parte da nota" até o
      // primeiro save. A recusa de "total" numa nota já parcialmente devolvida continua
      // acima (issue PARCIALMENTE_DEVOLVIDA de montarRascunhoDeOriginal, com o pedido).
      const escopo=escopoDaDevolucao({saldos:m.saldos.map(s=>({...s,chaveAcesso:m.origem.chaveAcesso})),itens:m.refs.map(r=>({chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal,quantidade:r.quantidade}))});
      return {draftId:await this.repo.criar(tx,userId,actorUserId,{...m,escopo}),reutilizado:false,escopo};
    });
  }
  /**
   * Devolução manual: pelo XML da nota original, ou pela chave com os itens digitados.
   *
   * - Chave (sem XML): a chave é conferida contra a EMPRESA antes de montar
   *   (`conferirChaveDevolucaoManual`) — recusa em `erros` por campo, no mesmo 400 do parser.
   * - Rascunho aberto da MESMA chave e do MESMO tipo: é reaproveitado (`reutilizado: true`,
   *   HTTP 200), como em "Devolver" — cada clique criava outro (a DLS acumulou 5 da mesma
   *   nota da DISAUTO). Pela chave, só quando os itens digitados são os mesmos do rascunho:
   *   itens diferentes não cabem nele (a nota original gravada não muda) e criar outro é o
   *   que não perde o que ela digitou.
   * - Quantidade: o saldo do livro de devoluções, sob o lock da chave (ver montagem-manual).
   */
  async manual(userId:string,actorUserId:string,input:ManualValidado):Promise<{draftId:string;reutilizado:boolean}> {
    const config=await this.config(userId,input.companyFiscalConfigId);
    if(input.modo==="CHAVE") {
      const conferencia=conferirChaveDevolucaoManual({tipo:input.tipo,chaveAcesso:input.chaveAcesso,destinatario:input.destinatario,itens:input.itens,emitente:{cnpj:config.cnpj,uf:config.uf}});
      if(conferencia.erros.length)throw new DevolucaoError("PAYLOAD_INVALIDO",undefined,{erros:conferencia.erros});
    }
    const lida=lerOrigemManual(input,config);
    const chave=lida.origem.chaveAcesso;
    return this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,[chave]);
      const notaOriginal=input.tipo==="VENDA_ENTRADA"?await this.repo.notaPorChave(userId,chave,tx):null;
      recusarChaveDeNotaComXml(input,notaOriginal);
      const aberta=await this.repo.aberta(userId,chave,tx,input.tipo);
      if(aberta) {
        const existente=input.modo==="CHAVE"?await this.repo.get(userId,aberta,tx):null;
        const origemExistente=existente?.cabecalho.origensJson.find(o=>o.chaveAcesso===chave);
        if(input.modo==="XML" || (origemExistente && mesmosItensDigitados(input,origemExistente)))return {draftId:aberta,reutilizado:true};
      }
      const linhas=await this.repo.linhasSaldo(userId,chave,tx);
      const completa:OrigemManualLida=completarOrigemManual(lida,{modo:input.modo,linhas,notaOriginal});
      const saldos=calcularSaldoPorItem({itensOriginais:completa.origem.itens.map(i=>({nItem:i.nItem,quantidade:i.quantidade||null})),linhas,chave});
      const m=montarRascunhoManual(input,config,{lida:completa,saldos});
      return {draftId:await this.repo.criar(tx,userId,actorUserId,m,input.modo==="CHAVE",input.devolvidaAposEntrega),reutilizado:false};
    });
  }
  /** Ver `PreviaDevolucaoManual`. Só leitura: nada é criado nem travado. */
  async previaManual(userId:string,input:ManualValidado):Promise<PreviaDevolucaoManual> {
    const config=await this.config(userId,input.companyFiscalConfigId);
    if(input.modo==="CHAVE") {
      const conferencia=conferirChaveDevolucaoManual({tipo:input.tipo,chaveAcesso:input.chaveAcesso,destinatario:input.destinatario,itens:input.itens,emitente:{cnpj:config.cnpj,uf:config.uf}});
      if(conferencia.erros.length)throw new DevolucaoError("PAYLOAD_INVALIDO",undefined,{erros:conferencia.erros});
    }
    const lida=lerOrigemManual(input,config);
    const chave=lida.origem.chaveAcesso;
    const notaOriginal=input.tipo==="VENDA_ENTRADA"?await this.repo.notaPorChave(userId,chave):null;
    recusarChaveDeNotaComXml(input,notaOriginal);
    const linhas=await this.repo.linhasSaldo(userId,chave);
    const {origem,destinatario}=completarOrigemManual(lida,{modo:input.modo,linhas,notaOriginal});
    const saldos=calcularSaldoPorItem({itensOriginais:origem.itens.map(i=>({nItem:i.nItem,quantidade:i.quantidade||null})),linhas,chave});
    const crt=crtDeRegime(config.regimeTributario);
    const rascunhoAberto=await this.repo.aberta(userId,chave,this.repo.db,input.tipo);
    return {chaveAcesso:chave,numero:origem.numero,serie:origem.serie,emitenteCnpjCpf:origem.emitenteCnpjCpf,destinatarioNome:destinatario?.nome??null,rascunhoAberto,
      itens:origem.itens.map(i=>{
        const s=saldos.find(x=>x.nItem===i.nItem);
        const m=mapearCfopDevolucao({cfopOriginal:i.cfop,tipo:input.tipo,idDestOriginal:origem.idDest,crt});
        return {nItem:i.nItem,codigo:i.codigo,descricao:i.descricao,unidade:i.unidade,valorUnitario:i.valorUnitario,
          quantidadeOriginal:s?.quantidadeOriginal??null,devolvidaAutorizada:s?.devolvidaAutorizada??0,emProcessamento:s?.emProcessamento??0,emRascunho:s?.emRascunho??0,disponivel:s?.disponivel??null,
          cfopOriginal:i.cfop||null,cfopSugerido:m.cfop??null,cfopOpcoes:m.opcoes,cfopStatus:m.status};
      })};
  }
  async detalhe(userId:string,id:string,db?:FiscalSql):Promise<DevolucaoDetalhe> {
    const n=await this.repo.nota(userId,id,db);if(!n)throw new DevolucaoError("NAO_ENCONTRADA");
    const config=await this.config(userId,n.companyFiscalConfigId);
    const d=await this.repo.get(userId,id,db);if(!d)throw new DevolucaoError("DEVOLUCAO_NAO_GERENCIADA");
    return this.detalhar(d,config,db);
  }
  /**
   * Saldo de cada item das originais deste rascunho, EXCLUINDO ele mesmo. A quantidade
   * original desconhecida (devolução pela chave) vem do livro quando uma devolução do
   * XML já a gravou (`itensOriginaisComLivro`) — sem isso a mesma peça podia ser
   * devolvida de novo pela chave.
   */
  private async saldosDoRascunho(d:DevolucaoPersistida,db?:FiscalSql):Promise<{saldos:SaldoComChave[];linhas:Map<string,LinhaSaldoDevolucao[]>}> {
    const saldos:SaldoComChave[]=[];const linhasPorChave=new Map<string,LinhaSaldoDevolucao[]>();
    for(const origem of d.cabecalho.origensJson) {
      const linhas=await this.repo.linhasSaldo(d.cabecalho.userId,origem.chaveAcesso,db);
      linhasPorChave.set(origem.chaveAcesso,linhas);
      saldos.push(...calcularSaldoPorItem({itensOriginais:itensOriginaisComLivro(origem.itens,linhas,origem.chaveAcesso),linhas,chave:origem.chaveAcesso,excluirDevolucaoNfeId:d.nota.id}).map(s=>({...s,chaveAcesso:origem.chaveAcesso})));
    }
    return {saldos,linhas:linhasPorChave};
  }
  private async detalhar(d:DevolucaoPersistida,config:CompanyFiscalConfig,db?:FiscalSql):Promise<DevolucaoDetalhe> {
    const {cabecalho:h,nota:n}=d;
    const {saldos,linhas:linhasPorChave}=await this.saldosDoRascunho(d,db);
    const originais=await (db??this.repo.db).$queryRawUnsafe<Array<{chaveAcesso:string;status:string;ambiente:string}>>(`SELECT regexp_replace("chaveAcesso",'[^0-9]','','g') AS "chaveAcesso","status","ambiente" FROM "NfeEmitida" WHERE "userId"=$1 AND regexp_replace("chaveAcesso",'[^0-9]','','g')=ANY($2::text[])`,h.userId,h.origensJson.map(o=>o.chaveAcesso));
    // Ambiente de EMISSÃO = o da config atual (o orquestrador monta a chave fiscal com ele),
    // não o da linha (ambiente de criação do rascunho): rascunho criado em homologação e
    // emitido depois da troca para produção cai em AMBIENTE_DIVERGENTE.
    const ambienteEmissao=config.ambiente;
    // Regime do emitente: o MESMO `crtDeRegime` que a validação (rejeições 590/591)
    // e o `aplicarOverrideTributacao` de `itens()` usam — por isso sai daqui um só,
    // para a tela nunca recusar o que o servidor aceita, nem aceitar o que ele recusa.
    // Com o TIPO: é ele que ordena as opções de PIS/COFINS pelo sentido da nota
    // (`emitente.pisCofinsOpcoes`), e o que a tela usa para o seletor.
    const emitente=regimeEmitenteDevolucao(config.regimeTributario,h.tipo);
    const issues=validarDevolucao({cabecalho:h,nota:{...n,ambiente:ambienteEmissao,destinatarioCpfCnpj:n.destinatarioJson?.cpfCnpj},emitente:{cnpj:config.cnpj,crt:emitente.crt},itens:n.itens,
      refs:d.refs.map(r=>({...r,chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal,quantidadeOriginal:r.quantidadeOriginal??saldos.find(s=>s.chaveAcesso===r.chaveAcessoOriginal && s.nItem===r.nItemOriginal)?.quantidadeOriginal??null})),saldos,originais,idDestOriginal:h.origensJson[0]?.idDest});
    return {draftId:n.id,status:n.status,tipo:h.tipo,fonte:h.fonte,escopo:h.escopoSolicitado,devolvidaAposEntrega:h.devolvidaAposEntrega,confirmadoSemXml:h.confirmadoSemXml,indFinal:h.indFinal,
      modoReferencia:modoReferenciaDevolucao(ambienteEmissao,new Date(),devolucaoRefItemProdDesde()),emitente,
      originais:h.origensJson.map(o=>({...o,destinatarioNome:null})),issues,podeEmitir:!temBloqueio(issues),
      // A MESMA conta da emissão (`calcularDevolucao` usa `totaisDevolucao`), para a tela
      // mostrar ICMS, PIS, COFINS, IPI devolvido e o valor da nota ANTES de emitir.
      totais:totaisDevolucao({itens:n.itens,refs:d.refs,valorFrete:n.valorFrete}),
      itens:d.refs.map(r=>{
        const item=n.itens.find(i=>i.numero===r.ordem);const s=saldos.find(s=>s.chaveAcesso===r.chaveAcessoOriginal && s.nItem===r.nItemOriginal);
        const outrasDevolucoes=outrasDevolucoesDoItem(linhasPorChave.get(r.chaveAcessoOriginal),r.nItemOriginal,n.id);
        return {ordem:r.ordem,chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal,codigo:item?.codigo??r.codigoOriginal,descricao:item?.descricao??"",unidade:item?.unidade??"",ncm:item?.ncm??"",
          quantidadeOriginal:r.quantidadeOriginal??s?.quantidadeOriginal??null,devolvidaAutorizada:s?.devolvidaAutorizada??0,emProcessamento:s?.emProcessamento??0,emRascunho:s?.emRascunho??0,disponivel:s?.disponivel??null,quantidade:r.quantidade,valorUnitario:item?.valorUnitario??0,valor:r.valor,
          cfopOriginal:r.cfopOriginal,cfop:item?.cfop??"",cfopStatus:r.cfopMapeamento.status,cfopOpcoes:r.cfopMapeamento.opcoes,tributacao:r.tributacao,requerRevisao:r.tributacao.requerRevisao,
          // O imposto da nota original deste item, na proporção devolvida, com a frase pronta.
          // Devolução pela chave: não há imposto original (null).
          referenciaOriginal:h.fonte==="MANUAL"?null:referenciaImpostoOriginal({impostoOriginal:r.impostoOriginal,quantidadeOriginal:r.quantidadeOriginal,quantidade:r.quantidade,tipo:h.tipo}),
          outrasDevolucoes};
      }),
      itensForaDaDevolucao:this.itensForaDaDevolucao(d,config,saldos,linhasPorChave)};
  }
  /**
   * K11: as peças da nota original (snapshot `origensJson`) que NÃO estão nesta devolução
   * e ainda podem ser devolvidas — `disponivel` ≠ 0 (null = pela chave, sem saldo
   * verificável). Sem elas, a peça tirada sumia da tela ao recarregar e não tinha como
   * voltar (o PUT dos itens já aceita qualquer nItem de `origensJson`).
   *
   * Mesmo formato dos itens da devolução, com o que ela voltaria a ser: a quantidade é o
   * disponível (0 quando não se sabe — ela digita), o CFOP é o sugerido e a tributação é
   * a de PARTIDA (`baseTributariaDoItem`, a mesma do PUT, que recalcula ao voltar).
   * `ordem: 0` = fora da nota. Nada é gravado.
   */
  private itensForaDaDevolucao(d:DevolucaoPersistida,config:CompanyFiscalConfig,saldos:SaldoComChave[],linhasPorChave:Map<string,LinhaSaldoDevolucao[]>):DevolucaoItemDetalhe[] {
    const {cabecalho:h}=d;
    const crt=crtDeRegime(config.regimeTributario);
    const fora:DevolucaoItemDetalhe[]=[];
    for(const origem of h.origensJson) {
      for(const original of origem.itens) {
        if(d.refs.some(r=>r.chaveAcessoOriginal===origem.chaveAcesso && r.nItemOriginal===original.nItem))continue;
        const s=saldos.find(x=>x.chaveAcesso===origem.chaveAcesso && x.nItem===original.nItem)??null;
        const disponivel=s?.disponivel??null;
        const dispU=disponivel===null?null:quantidadeParaUnidades(disponivel);
        if(dispU!==null && dispU<=0)continue;
        const quantidade=disponivel??0;
        const qOriginal=original.quantidade||s?.quantidadeOriginal||null;
        const {tributacao,valor}=baseTributariaDoItem({fonte:h.fonte,original,quantidadeOriginal:qOriginal,quantidade,crtEmitente:crt,crtOriginal:origem.crtOriginal,tipo:h.tipo});
        const cfop=mapearCfopDevolucao({cfopOriginal:original.cfop,tipo:h.tipo,idDestOriginal:origem.idDest,crt});
        const imposto=h.fonte==="MANUAL"?null:original.impostoOriginal;
        fora.push({ordem:0,chaveAcesso:origem.chaveAcesso,nItem:original.nItem,codigo:original.codigo,descricao:original.descricao,unidade:original.unidade,ncm:original.ncm,
          quantidadeOriginal:qOriginal,devolvidaAutorizada:s?.devolvidaAutorizada??0,emProcessamento:s?.emProcessamento??0,emRascunho:s?.emRascunho??0,disponivel,quantidade,valorUnitario:original.valorUnitario,valor,
          cfopOriginal:original.cfop||null,cfop:cfop.cfop??"",cfopStatus:cfop.status,cfopOpcoes:cfop.opcoes,tributacao,requerRevisao:tributacao.requerRevisao,
          referenciaOriginal:imposto?referenciaImpostoOriginal({impostoOriginal:imposto,quantidadeOriginal:qOriginal,quantidade,tipo:h.tipo}):null,
          outrasDevolucoes:outrasDevolucoesDoItem(linhasPorChave.get(origem.chaveAcesso),original.nItem,d.nota.id)});
      }
    }
    return fora;
  }
  async cabecalho(userId:string,actorUserId:string,id:string,body:AtualizarCabecalhoBody) {
    const d=await this.repo.get(userId,id);if(!d)throw new DevolucaoError("DEVOLUCAO_NAO_GERENCIADA");
    await this.config(userId,d.nota.companyFiscalConfigId);
    if(body.tipo && body.tipo!==d.cabecalho.tipo)throw new DevolucaoError("RASCUNHO_ALTERADO");
    await this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,d.cabecalho.origensJson.map(o=>o.chaveAcesso));
      await this.repo.lockRascunho(tx,userId,id);
      // O escopo NÃO é mais escolhido: é derivado dos itens gravados (`escopoDaDevolucao`).
      // O `escopo` do corpo continua aceito (cliente antigo manda) e é ignorado: "Total" sobre
      // uma lista parcial fazia o rascunho mentir e recusar toda edição de quantidade.
      const atual=await this.repo.get(userId,id,tx);if(!atual)throw new DevolucaoError("NAO_ENCONTRADA");
      const {saldos}=await this.saldosDoRascunho(atual,tx);
      const escopo=escopoDaDevolucao({saldos,itens:atual.refs.map(r=>({chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal,quantidade:r.quantidade}))});
      await tx.$executeRawUnsafe(`UPDATE "NfeDevolucao" SET "devolvidaAposEntrega"=CASE WHEN $3 THEN $4 ELSE "devolvidaAposEntrega" END,"escopoSolicitado"=COALESCE($5,"escopoSolicitado"),"updatedAt"=GREATEST(NOW(),"updatedAt"+interval '1 millisecond') WHERE "userId"=$1 AND "nfeId"=$2`,userId,id,body.devolvidaAposEntrega!==undefined,body.devolvidaAposEntrega??null,escopo);
      await this.repo.audit(tx,userId,id,"DEVOLUCAO_ITENS_EDITADOS",{actorUserId,cabecalho:true});
    });
    return this.detalhe(userId,id);
  }
  async itens(userId:string,actorUserId:string,id:string,body:AtualizarItensBody) {
    const before=await this.repo.get(userId,id);if(!before)throw new DevolucaoError("DEVOLUCAO_NAO_GERENCIADA");
    const config=await this.config(userId,before.nota.companyFiscalConfigId);
    await this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,before.cabecalho.origensJson.map(o=>o.chaveAcesso));await this.repo.lockRascunho(tx,userId,id);
      const d=await this.repo.get(userId,id,tx);if(!d)throw new DevolucaoError("NAO_ENCONTRADA");
      const {saldos}=await this.saldosDoRascunho(d,tx);
      // Sem trava de "escopo Total": o escopo é DERIVADO dos itens gravados, no fim. A trava
      // recusava devolver MENOS peças com "Quantidade maior que o saldo" (DLS, 24/09,
      // rascunho 36730421, três vezes) e, pela chave, recusava até salvar sem mudar nada.
      const itens:NfeDraftItem[]=[];const refs:RefDevolucaoItem[]=[];
      // TODAS as recusas de todos os itens, antes de responder: uma de cada vez, ela
      // consertava um item e batia no seguinte. `ordem` = o item como a tela mostra (a
      // ordem gravada), não a posição na lista nova.
      const falha:{codigo:DevolucaoErroCodigo|null;issues:DevolucaoIssue[]}={codigo:null,issues:[]};
      const recusar=(codigo:DevolucaoErroCodigo,...issues:DevolucaoIssue[])=>{falha.issues.push(...issues);if(!falha.codigo)falha.codigo=codigo;};
      // Cada recusa diz também a PEÇA (nº do item na nota original + a chave), como os `erros`
      // do 400 (comItemDoCorpo): a `ordem` é o item na tela, e muda quando uma peça sai.
      const daPeca=(b:{chaveAcesso:string;nItem:number},i:DevolucaoIssue):DevolucaoIssue=>({...i,nItem:b.nItem,chaveAcesso:b.chaveAcesso});
      const crtEmitente=crtDeRegime(config.regimeTributario);
      const tipoOperacao=d.cabecalho.tipo==="COMPRA_SAIDA"?"SAIDA":"ENTRADA";
      for(const b of body.itens.filter(i=>i.quantidade>0)) {
        const origem=d.cabecalho.origensJson.find(o=>o.chaveAcesso===b.chaveAcesso);
        const original=origem?.itens.find(i=>i.nItem===b.nItem);if(!origem || !original)throw new DevolucaoError("ITEM_ORIGINAL_INEXISTENTE");
        const anterior=d.refs.find(r=>r.chaveAcessoOriginal===b.chaveAcesso && r.nItemOriginal===b.nItem);
        const ordem=itens.length+1;const ordemTela=anterior?.ordem??ordem;
        const saldo=saldos.find(i=>i.chaveAcesso===b.chaveAcesso && i.nItem===b.nItem)??null;
        const qOriginal=original.quantidade||saldo?.quantidadeOriginal||null;
        const dispU=saldo?.disponivel!=null?quantidadeParaUnidades(saldo.disponivel):null;
        if(dispU!==null && (quantidadeParaUnidades(b.quantidade)??0)>dispU) {
          recusar("SALDO_INSUFICIENTE",daPeca(b,issueSaldoExcedido({ordem:ordemTela,nItemOriginal:original.nItem,codigo:original.codigo,pedida:b.quantidade,saldo})));
          continue;
        }
        const cfopRecusado=issueCfop(ordemTela,b.cfop,tipoOperacao==="SAIDA"?"1":"0",origem.idDest);
        if(cfopRecusado){recusar("CFOP_INVALIDO",daPeca(b,cfopRecusado));continue;}
        const {tributacao:base,valor,desconto,baseCalculo}=baseTributariaDoItem({fonte:d.cabecalho.fonte,original,quantidadeOriginal:qOriginal,quantidade:b.quantidade,crtEmitente,crtOriginal:origem.crtOriginal,tipo:d.cabecalho.tipo});
        const t=anterior?.tributacao;
        // `ipiDevol:false` e a escolha de RETIRAR o IPI devolvido: sem reconstrui-la, o proximo save devolvia o IPI.
        const saved=t?.fonte==="USUARIO"?{icms:{cst:t.icms.cst,csosn:t.icms.csosn,modBC:t.icms.modBC,pICMS:t.icms.pICMS},pis:{cst:t.pis.cst,p:t.pis.p},cofins:{cst:t.cofins.cst,p:t.cofins.p},...(t.ipiDevol===null&&base.ipiDevol?{ipiDevol:false as const}:{})}:undefined;
        // Mescla com o que ela JÁ gravou (mesclarAjusteTributacao): tributo ausente do corpo fica
        // com o salvo; dentro do tributo, campo ausente também (o par cst/csosn do ICMS é atômico).
        const imposto=d.cabecalho.fonte==="MANUAL"?null:original.impostoOriginal;
        // `salvo` (decisão 5): o valor IGUAL ao já gravado não é ajuste novo e não é julgado de
        // novo — um PIS 01 antigo gravado numa empresa do Simples (rascunho 4a3698ee da DLS)
        // não barra salvar a QUANTIDADE. Quem barra a EMISSÃO por ele é validarDevolucao.
        const override=aplicarOverrideTributacao({base,override:mesclarAjusteTributacao(saved,b.tributacao),salvo:saved,confirmar:b.confirmarTributacao,crtEmitente,baseCalculoItem:baseCalculo,tipoOperacao,
          baseIcmsOriginal:referenciaImpostoOriginal({impostoOriginal:imposto,quantidadeOriginal:qOriginal,quantidade:b.quantidade,tipo:d.cabecalho.tipo})?.icms?.vBC??null});
        if(!override.ok) {
          // O motivo de CADA tributo recusado, no código da pendência que o descreve (antes o
          // 422 descartava `override.erros` e a tela dizia só "Tributação não suportada").
          recusar("TRIBUTACAO_NAO_SUPORTADA",...override.recusas.map((x):DevolucaoIssue=>daPeca(b,{code:x.code,severidade:"ERRO",ordem:ordemTela,mensagem:`Item ${ordemTela}: ${x.tributo}: ${x.motivo}`})));
          continue;
        }
        itens.push({numero:ordem,codigo:original.codigo,descricao:original.descricao,ncm:original.ncm,cest:original.cest,cfop:b.cfop,unidade:original.unidade,origem:(original.origem??0) as NfeDraftItem["origem"],quantidade:b.quantidade,valorUnitario:original.valorUnitario,valorTotal:valor,desconto});
        refs.push({ordem,originalNfeId:origem.originalNfeId,chaveAcessoOriginal:origem.chaveAcesso,nItemOriginal:original.nItem,codigoOriginal:original.codigo,cfopOriginal:original.cfop,quantidadeOriginal:qOriginal,valorUnitarioOriginal:original.valorUnitario,quantidade:b.quantidade,valor,impostoOriginal:imposto,tributacao:override.tributacao,cfopMapeamento:mapearCfopDevolucao({cfopOriginal:original.cfop,tipo:d.cabecalho.tipo,idDestOriginal:origem.idDest,crt:crtEmitente})});
      }
      if(falha.codigo)throw new DevolucaoError(falha.codigo,falha.issues);
      if(!itens.length)throw new DevolucaoError("PAYLOAD_INVALIDO",undefined,{erros:[{campo:"itens",mensagem:"Escolha pelo menos um item para devolver."}]});
      await this.repo.gravarItens(tx,userId,id,itens,refs,escopoDaDevolucao({saldos,itens:refs.map(r=>({chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal,quantidade:r.quantidade}))}));
      await this.repo.audit(tx,userId,id,"DEVOLUCAO_ITENS_EDITADOS",{actorUserId});
    });
    return this.detalhe(userId,id);
  }
  async saldo(userId:string,id:string):Promise<SaldoResposta> {
    const {n,c,parsed}=await this.original(userId,id);
    const linhas=await this.repo.linhasSaldo(userId,parsed.chaveAcesso);
    const m=montarRascunhoDeOriginal({original:{...n,companyFiscalConfigId:n.companyFiscalConfigId??null},config:c,parsed,idDestOriginal:parsed.ide.idDest!,linhasSaldo:linhas,itensNfe:[],escopo:"PARCIAL",tipo:"VENDA_ENTRADA"});
    const devolucoes=[];
    for(const nfeId of new Set(linhas.map(l=>l.devolucaoNfeId))) {
      const doNfe=linhas.filter(l=>l.devolucaoNfeId===nfeId);
      // Nº, série e status já vêm na linha (o linhasSaldo faz JOIN na NfeEmitida): sem uma
      // consulta por devolução a cada abertura da ficha (regra de egress 5) — o repo.nota
      // trazia n.* e todos os itens só para ler estes três. Linha sem eles: o caminho antigo.
      const p=doNfe[0];
      const nota=p.numeroDevolucao!=null && p.serieDevolucao!=null
        ?{numero:Number(p.numeroDevolucao),serie:Number(p.serieDevolucao),status:p.statusDevolucao as NfeStatus}
        :await this.repo.nota(userId,nfeId);
      if(!nota)continue;
      devolucoes.push({nfeId,numero:nota.numero>0?nota.numero:null,serie:nota.serie,status:nota.status,itens:doNfe.map(l=>({nItem:l.nItem,quantidade:Number(l.quantidade)}))});
    }
    const totalmenteDevolvida=m.saldos.every(s=>s.disponivel===0);
    return {original:{nfeId:id,chaveAcesso:parsed.chaveAcesso,numero:m.origem.numero,serie:m.origem.serie,modelo:n.modelo,status:n.status,dataEmissao:m.origem.dataEmissao,destinatarioNome:n.destinatarioJson?.nome??null,destinatarioCpfCnpj:n.destinatarioJson?.cpfCnpj??null},
      elegivel:!totalmenteDevolvida,motivo:totalmenteDevolvida?"TOTALMENTE_DEVOLVIDA":null,totalmenteDevolvida,devolucoes,
      itens:m.saldos.map(s=>{const i=m.origem.itens.find(i=>i.nItem===s.nItem)!;return {...s,codigo:i.codigo,descricao:i.descricao,unidade:i.unidade,valorUnitario:i.valorUnitario};})};
  }
  async contextoEmissao(userId:string,id:string):Promise<{dados:DevolucaoPersistida;contexto:ContextoEmissaoDevolucao}> {
    const dados=await this.repo.get(userId,id);if(!dados)throw new DevolucaoError("DEVOLUCAO_NAO_GERENCIADA");
    const config=await this.config(userId,dados.nota.companyFiscalConfigId);
    const detalhe=await this.detalhar(dados,config);
    if(!detalhe.podeEmitir)throw new DevolucaoError("DEVOLUCAO_INVALIDA",detalhe.issues);
    return {dados,contexto:{modoReferencia:detalhe.modoReferencia,indFinal:dados.cabecalho.indFinal,refs:dados.refs}};
  }
  async validarReserva(userId:string,id:string,before:DevolucaoPersistida,tx:FiscalSql):Promise<void> {
    await this.repo.lockOrigens(tx,userId,before.cabecalho.origensJson.map(o=>o.chaveAcesso));
    const atual=await this.repo.get(userId,id,tx);
    if(!atual || hashConteudo({cabecalho:atual.cabecalho,refs:atual.refs})!==hashConteudo({cabecalho:before.cabecalho,refs:before.refs}))throw new DevolucaoError("RASCUNHO_ALTERADO");
    const config=await this.config(userId,atual.nota.companyFiscalConfigId);
    const detalhe=await this.detalhar(atual,config,tx);
    if(!detalhe.podeEmitir)throw new DevolucaoError("DEVOLUCAO_INVALIDA",detalhe.issues);
  }
  /**
   * Passos depois da autorização (vínculo na original e auditoria de saldo). IDEMPOTENTE:
   * se `DEVOLUCAO_AUTORIZADA` já foi gravado, não grava de novo — para o replay depois de
   * uma queda (completarPosAutorizacao) poder chamar sem duplicar os eventos.
   */
  async registrarAutorizacao(userId:string,id:string):Promise<void> {
    const before=await this.repo.get(userId,id);if(!before)return;
    await this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,before.cabecalho.origensJson.map(o=>o.chaveAcesso));
      if(await this.repo.temEvento(tx,userId,id,"DEVOLUCAO_AUTORIZADA"))return;
      for(const r of before.refs) {
        if(r.originalNfeId)await this.repo.audit(tx,userId,r.originalNfeId,"DEVOLUCAO_VINCULADA",{devolucaoNfeId:id,nItem:r.nItemOriginal,quantidade:r.quantidade});
        const linhas=await this.repo.linhasSaldo(userId,r.chaveAcessoOriginal,tx);
        // Em unidades de 1/10000, como o resto do saldo: 0,1 + 0,2 em ponto flutuante dá
        // 0,30000000000000004 e gravava "devolução acima da nota" numa peça de 0,3 m.
        const unidades=linhas.filter(l=>l.nItem===r.nItemOriginal && l.statusDevolucao==="AUTHORIZED").reduce((s,l)=>s+(quantidadeParaUnidades(l.quantidade)??0),0);
        // Devolução pela chave sem a quantidade da nota: a que o livro conhece (devolução do XML).
        const quantidadeOriginal=r.quantidadeOriginal??quantidadeOriginalDoLivro(linhas,r.chaveAcessoOriginal,r.nItemOriginal);
        const limite=quantidadeOriginal==null?null:quantidadeParaUnidades(quantidadeOriginal);
        if(limite!=null && unidades>limite)await this.repo.audit(tx,userId,id,"DEVOLUCAO_SALDO_EXCEDIDO",{chave:r.chaveAcessoOriginal,nItem:r.nItemOriginal,quantidade:unidadesParaQuantidade(unidades)});
      }
      await this.repo.audit(tx,userId,id,"DEVOLUCAO_AUTORIZADA",{originais:before.cabecalho.origensJson.map(o=>o.chaveAcesso)});
    });
  }
  /**
   * Os rascunhos de devolução em aberto do usuário (DRAFT/REJECTED), COM e SEM cabeçalho
   * de devolução, das empresas com a devolução ligada — para a tela listar, continuar e
   * descartar (a lista de notas esconde rascunho; a DLS tinha 7 invisíveis, um deles, feito
   * à mão, segurando o nº 712). Descartar é o DELETE /nfe/draft/:id que já existe: as FKs
   * de NfeDevolucao e NfeDevolucaoItem são ON DELETE CASCADE.
   *
   * Sem empresa com a devolução ligada: lista VAZIA (200), e sem consulta ao banco por
   * requisição (`donosComDevolucao`) — a tela chama isto a cada carga da lista de notas, em
   * todo cliente; antes cada carga custava um SELECT e um 404.
   */
  async abertas(userId:string):Promise<{abertas:DevolucaoAbertaResumo[]}> {
    const donos=await this.donosComDevolucao();
    if(donos && !donos.has(userId))return {abertas:[]};
    const configs=await this.repo.configsDoUsuario(userId);
    const padrao=configs.find(c=>c.isDefault)?.id??null;
    if(!configs.some(c=>isDevolucaoAtiva(c.id)))return {abertas:[]};
    const linhas=(await this.repo.abertasDoUsuario(userId)).filter(l=>isDevolucaoAtiva(l.companyFiscalConfigId??padrao));
    const reservas=await this.repo.reservasVivas(userId,linhas.map(l=>l.id));
    const iso=(v:Date|string)=>new Date(v).toISOString();
    return {abertas:linhas.map(l=>{
      const r=reservas.find(x=>x.nfeId===l.id);
      return {draftId:l.id,status:l.status,gerenciada:l.tipo!==null,tipo:l.tipo,fonte:l.fonte,tipoOperacao:l.tipoOperacao,destinatarioNome:l.destinatarioNome??null,
        originais:(l.originais??[]).map(o=>({chaveAcesso:o.chaveAcesso,numero:Number(o.numero),serie:Number(o.serie)})),quantidadeItens:Number(l.quantidadeItens)||0,
        criadaEm:iso(l.createdAt),atualizadaEm:iso(l.updatedAt),numeracao:r?{numero:Number(r.numero),serie:Number(r.serie),estado:r.estado,ambiente:r.ambiente}:null};
    })};
  }
  /**
   * GET /nfe/devolucao/disponibilidade (ver `DisponibilidadeDevolucaoResposta`): as
   * empresas do usuário com a devolução ligada (K12: com mais de um CNPJ a tela manual
   * precisa escolher) e, no campo de sempre, a padrão quando ela está ligada — a resposta
   * de antes, byte a byte, para a padrão ligada, mais `empresas`. Nenhuma ligada: 404.
   */
  async disponibilidade(userId:string):Promise<DisponibilidadeDevolucaoResposta> {
    const indisponivel=()=>new NumeracaoError("RECURSO_INDISPONIVEL",404,"Recurso indisponível");
    const donos=await this.donosComDevolucao();
    if(donos && !donos.has(userId))throw indisponivel();
    // A padrão é a 1ª linha (isDefault desc, createdAt asc) — a mesma de findByUserId.
    const todas=await this.repo.empresasDoUsuario(userId);
    const ligadas=todas.filter(c=>isDevolucaoAtiva(c.id));
    if(!ligadas.length)throw indisponivel();
    const padrao=todas[0];
    const companyFiscalConfigId=isDevolucaoAtiva(padrao.id)?padrao.id:ligadas.length===1?ligadas[0].id:null;
    return {disponivel:true,companyFiscalConfigId,
      empresas:ligadas.map(c=>({companyFiscalConfigId:c.id,cnpj:c.cnpj,razaoSocial:c.razaoSocial,nomeFantasia:c.nomeFantasia??null,uf:c.uf??null,ambiente:c.ambiente,isDefault:c.isDefault===true}))};
  }
  /**
   * Quem PODE ter a devolução ligada, sem ir ao banco a cada requisição:
   *  - conjunto vazio: ninguém (devolução desligada, ou nenhuma config da allowlist
   *    passa em `isDevolucaoAtiva`) — sem consulta nenhuma;
   *  - conjunto de userIds: os donos das configs da allowlist, consultados UMA vez e
   *    guardados por 10 min (a allowlist vem da env; o dono de uma config não muda);
   *  - `null`: allowlist "*" (todos podem ter) — decide a consulta de cada usuário.
   * É só um atalho para o "não": quem está no conjunto passa pela regra de sempre
   * (`isDevolucaoAtiva` sobre as configs DELE).
   */
  private donosCache:{chave:string;ate:number;donos:Set<string>}|null=null;
  private async donosComDevolucao():Promise<Set<string>|null> {
    if(process.env.NFE_DEVOLUCAO_ENABLED!=="true")return new Set();
    const bruto=(process.env.NFE_DEVOLUCAO_CONFIG_IDS??"").trim();
    if(bruto==="*")return null;
    const ids=[...new Set(bruto.split(",").map(x=>x.trim()).filter(x=>x!=="" && x!=="*"))].filter(id=>isDevolucaoAtiva(id));
    if(!ids.length)return new Set();
    const chave=ids.join(",");const agora=Date.now();
    if(this.donosCache && this.donosCache.chave===chave && this.donosCache.ate>agora)return this.donosCache.donos;
    const donos=new Set(await this.repo.donosDasConfigs(ids));
    this.donosCache={chave,ate:agora+DONOS_COM_DEVOLUCAO_TTL_MS,donos};
    return donos;
  }
}

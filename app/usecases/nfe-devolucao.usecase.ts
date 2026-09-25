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
import { calcularSaldoPorItem, escopoDaDevolucao, issueSaldoExcedido, itensOriginaisComLivro, quantidadeOriginalDoLivro, quantidadeParaUnidades } from "../fiscal/devolucao/saldo";
import type { LinhaSaldoDevolucao } from "../fiscal/devolucao/saldo";
import { crtDeRegime, aplicarOverrideTributacao, referenciaImpostoOriginal, regimeEmitenteDevolucao } from "../fiscal/devolucao/tributacao";
import { mapearCfopDevolucao, isCfopPermitidoEmDevolucao, idDestDoCfop } from "../fiscal/domain/devolucao-cfop";
import { validarDevolucao, temBloqueio } from "../fiscal/devolucao/validacao";
import { modoReferenciaDevolucao } from "../fiscal/devolucao/modo-referencia";
import { conferirChaveDevolucaoManual } from "../fiscal/devolucao/contrato";
import type { AtualizarCabecalhoBody, AtualizarItensBody, CriarDevolucaoBody, DevolucaoDetalhe, DevolucaoErroCodigo, ManualValidado, SaldoResposta } from "../fiscal/devolucao/contrato";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";
import type { NfeDraftItem } from "../interfaces/nfe.interface";
import type { DevolucaoIssue, EscopoDevolucao, FonteDevolucao, OrigemDevolucaoSnapshot, RefDevolucaoItem, SaldoItemOriginal, TipoDevolucao, TributacaoOverride } from "../fiscal/devolucao/tipos";
import { totaisDevolucao } from "../fiscal/devolucao/emissao";
import type { ContextoEmissaoDevolucao } from "../fiscal/devolucao/emissao";
import { hashConteudo } from "../fiscal/numeracao/decisao";
import { createNfeProvider } from "../fiscal/providers/provider-factory";
import { FocusNfeProvider } from "../fiscal/providers/focus-nfe.provider";
import { NfeNumeracaoService } from "../fiscal/numeracao/numeracao.service";

type SaldoComChave = SaldoItemOriginal & {chaveAcesso:string};

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

/** A tela da devolução manual digita os mesmos itens de novo? (mesmos dados fixos da nota original) */
function mesmosItensDigitados(input:ManualValidado,origem:OrigemDevolucaoSnapshot):boolean {
  if(input.modo!=="CHAVE")return true;
  return input.itens.every(i=>{
    const o=origem.itens.find(x=>x.nItem===i.nItem);
    return !!o && o.codigo===i.codigo && o.descricao===i.descricao && o.ncm===i.ncm && o.unidade===i.unidade && (o.cest??null)===(i.cest??null)
      && o.cfop===(i.cfopOriginal??"") && o.valorUnitario===i.valorUnitario && (o.origem??null)===(i.origem??null);
  });
}

/** Rascunho de devolução em aberto, para a tela listar e oferecer "Continuar"/"Descartar". */
export interface DevolucaoAbertaResumo {
  draftId:string;
  status:string;
  /** false = rascunho com finalidade devolução feito à mão (sem cabeçalho): só dá para descartar. */
  gerenciada:boolean;
  tipo:TipoDevolucao|null;
  fonte:FonteDevolucao|null;
  tipoOperacao:string;
  destinatarioNome:string|null;
  originais:Array<{chaveAcesso:string;numero:number;serie:number}>;
  quantidadeItens:number;
  criadaEm:string;
  atualizadaEm:string;
  /** Número fiscal preso a este rascunho (reserva viva). null = nenhum. */
  numeracao:{numero:number;serie:number;estado:string;ambiente:string}|null;
}

/**
 * Prévia da devolução manual, SEM criar nada: os itens da nota original com o que ainda
 * pode ser devolvido de cada um (livro de devoluções) e o CFOP sugerido — para a tela
 * deixar escolher as peças ANTES de criar o rascunho (hoje nasce com todas e ela zera à
 * mão) — e o rascunho já aberto desta nota, se houver (a criação vai reaproveitá-lo).
 */
export interface PreviaDevolucaoManual {
  chaveAcesso:string;
  numero:number;
  serie:number;
  emitenteCnpjCpf:string;
  /** Quem recebe a devolução: o fornecedor (compra) ou o cliente (venda). */
  destinatarioNome:string|null;
  /** Rascunho aberto desta nota e deste tipo: criar de novo devolve ELE (`reutilizado`). */
  rascunhoAberto:string|null;
  itens:Array<{nItem:number;codigo:string;descricao:string;unidade:string;valorUnitario:number;
    quantidadeOriginal:number|null;devolvidaAutorizada:number;emProcessamento:number;emRascunho:number;disponivel:number|null;
    cfopOriginal:string|null;cfopSugerido:string|null;cfopOpcoes:string[];cfopStatus:string}>;
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
      return {draftId:await this.repo.criar(tx,userId,actorUserId,m),reutilizado:false};
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
      const aberta=await this.repo.aberta(userId,chave,tx,input.tipo);
      if(aberta) {
        const existente=input.modo==="CHAVE"?await this.repo.get(userId,aberta,tx):null;
        const origemExistente=existente?.cabecalho.origensJson.find(o=>o.chaveAcesso===chave);
        if(input.modo==="XML" || (origemExistente && mesmosItensDigitados(input,origemExistente)))return {draftId:aberta,reutilizado:true};
      }
      const linhas=await this.repo.linhasSaldo(userId,chave,tx);
      const notaOriginal=input.tipo==="VENDA_ENTRADA"?await this.repo.notaPorChave(userId,chave,tx):null;
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
    const linhas=await this.repo.linhasSaldo(userId,chave);
    const notaOriginal=input.tipo==="VENDA_ENTRADA"?await this.repo.notaPorChave(userId,chave):null;
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
        // Onde mais este item da nota original está: outros rascunhos (não seguram saldo,
        // mas o primeiro a sair zera os outros) e devoluções autorizadas/em envio.
        const outrasDevolucoes=(linhasPorChave.get(r.chaveAcessoOriginal)??[]).filter(l=>l.nItem===r.nItemOriginal && l.devolucaoNfeId!==n.id && !["CANCELLED","INUTILIZED"].includes(l.statusDevolucao))
          .map(l=>({nfeId:l.devolucaoNfeId,status:l.statusDevolucao,numero:typeof l.numeroDevolucao==="number" && l.numeroDevolucao>0?l.numeroDevolucao:null,serie:l.serieDevolucao??null,quantidade:Number(l.quantidade),criadaEm:l.criadaEm==null?null:new Date(l.criadaEm).toISOString()}));
        return {ordem:r.ordem,chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal,codigo:item?.codigo??r.codigoOriginal,descricao:item?.descricao??"",unidade:item?.unidade??"",ncm:item?.ncm??"",
          quantidadeOriginal:r.quantidadeOriginal??s?.quantidadeOriginal??null,devolvidaAutorizada:s?.devolvidaAutorizada??0,emProcessamento:s?.emProcessamento??0,emRascunho:s?.emRascunho??0,disponivel:s?.disponivel??null,quantidade:r.quantidade,valorUnitario:item?.valorUnitario??0,valor:r.valor,
          cfopOriginal:r.cfopOriginal,cfop:item?.cfop??"",cfopStatus:r.cfopMapeamento.status,cfopOpcoes:r.cfopMapeamento.opcoes,tributacao:r.tributacao,requerRevisao:r.tributacao.requerRevisao,
          // O imposto da nota original deste item, na proporção devolvida, com a frase pronta.
          // Devolução pela chave: não há imposto original (null).
          referenciaOriginal:h.fonte==="MANUAL"?null:referenciaImpostoOriginal({impostoOriginal:r.impostoOriginal,quantidadeOriginal:r.quantidadeOriginal,quantidade:r.quantidade,tipo:h.tipo}),
          outrasDevolucoes};
      })};
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
          recusar("SALDO_INSUFICIENTE",issueSaldoExcedido({ordem:ordemTela,nItemOriginal:original.nItem,codigo:original.codigo,pedida:b.quantidade,saldo}));
          continue;
        }
        const cfopRecusado=issueCfop(ordemTela,b.cfop,tipoOperacao==="SAIDA"?"1":"0",origem.idDest);
        if(cfopRecusado){recusar("CFOP_INVALIDO",cfopRecusado);continue;}
        const {tributacao:base,valor,desconto,baseCalculo}=baseTributariaDoItem({fonte:d.cabecalho.fonte,original,quantidadeOriginal:qOriginal,quantidade:b.quantidade,crtEmitente,crtOriginal:origem.crtOriginal,tipo:d.cabecalho.tipo});
        const t=anterior?.tributacao;
        // `ipiDevol:false` e a escolha de RETIRAR o IPI devolvido: sem reconstrui-la, o proximo save devolvia o IPI.
        const saved=t?.fonte==="USUARIO"?{icms:{cst:t.icms.cst,csosn:t.icms.csosn,modBC:t.icms.modBC,pICMS:t.icms.pICMS},pis:{cst:t.pis.cst,p:t.pis.p},cofins:{cst:t.cofins.cst,p:t.cofins.p},...(t.ipiDevol===null&&base.ipiDevol?{ipiDevol:false as const}:{})}:undefined;
        // Mescla com o que ela JÁ gravou (mesclarAjusteTributacao): tributo ausente do corpo fica
        // com o salvo; dentro do tributo, campo ausente também (o par cst/csosn do ICMS é atômico).
        const imposto=d.cabecalho.fonte==="MANUAL"?null:original.impostoOriginal;
        const override=aplicarOverrideTributacao({base,override:mesclarAjusteTributacao(saved,b.tributacao),confirmar:b.confirmarTributacao,crtEmitente,baseCalculoItem:baseCalculo,tipoOperacao,
          baseIcmsOriginal:referenciaImpostoOriginal({impostoOriginal:imposto,quantidadeOriginal:qOriginal,quantidade:b.quantidade,tipo:d.cabecalho.tipo})?.icms?.vBC??null});
        if(!override.ok) {
          // O motivo de CADA tributo recusado, no código da pendência que o descreve (antes o
          // 422 descartava `override.erros` e a tela dizia só "Tributação não suportada").
          recusar("TRIBUTACAO_NAO_SUPORTADA",...override.recusas.map((x):DevolucaoIssue=>({code:x.code,severidade:"ERRO",ordem:ordemTela,mensagem:`Item ${ordemTela}: ${x.tributo}: ${x.motivo}`})));
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
      const nota=await this.repo.nota(userId,nfeId);if(!nota)continue;
      devolucoes.push({nfeId,numero:nota.numero>0?nota.numero:null,serie:nota.serie,status:nota.status,itens:linhas.filter(l=>l.devolucaoNfeId===nfeId).map(l=>({nItem:l.nItem,quantidade:Number(l.quantidade)}))});
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
        const quantidade=linhas.filter(l=>l.nItem===r.nItemOriginal && l.statusDevolucao==="AUTHORIZED").reduce((s,l)=>s+Number(l.quantidade),0);
        // Devolução pela chave sem a quantidade da nota: a que o livro conhece (devolução do XML).
        const quantidadeOriginal=r.quantidadeOriginal??quantidadeOriginalDoLivro(linhas,r.chaveAcessoOriginal,r.nItemOriginal);
        if(quantidadeOriginal!=null && quantidade>quantidadeOriginal)await this.repo.audit(tx,userId,id,"DEVOLUCAO_SALDO_EXCEDIDO",{chave:r.chaveAcessoOriginal,nItem:r.nItemOriginal,quantidade});
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
   */
  async abertas(userId:string):Promise<{abertas:DevolucaoAbertaResumo[]}> {
    const configs=await this.repo.configsDoUsuario(userId);
    const padrao=configs.find(c=>c.isDefault)?.id??null;
    if(!configs.some(c=>isDevolucaoAtiva(c.id)))throw new NumeracaoError("RECURSO_INDISPONIVEL",404,"Recurso indisponível");
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
}

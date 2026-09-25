import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { NfeDevolucaoRepository } from "../fiscal/devolucao/devolucao.repository";
import type { DevolucaoPersistida, FiscalSql } from "../fiscal/devolucao/devolucao.repository";
import { DevolucaoError } from "../fiscal/devolucao/devolucao.errors";
import { NumeracaoError } from "../fiscal/numeracao/numeracao.errors";
import { isDevolucaoAtiva, isNumeracaoV2ParaEmissao, devolucaoRefItemProdDesde } from "../fiscal/flags";
import { FiscalStorageService } from "../fiscal/storage/fiscal-storage.service";
import { parseNfeXml } from "../fiscal/sefaz/nfe-xml-parser.service";
import { montarRascunhoDeOriginal } from "../fiscal/devolucao/montagem";
import { montarRascunhoManual } from "../fiscal/devolucao/montagem-manual";
import { calcularSaldoPorItem } from "../fiscal/devolucao/saldo";
import { crtDeRegime, proporcionalizar, aplicarOverrideTributacao, regimeEmitenteDevolucao, round2 } from "../fiscal/devolucao/tributacao";
import { mapearCfopDevolucao, isCfopPermitidoEmDevolucao, idDestDoCfop } from "../fiscal/domain/devolucao-cfop";
import { validarDevolucao, temBloqueio } from "../fiscal/devolucao/validacao";
import { modoReferenciaDevolucao } from "../fiscal/devolucao/modo-referencia";
import type { AtualizarCabecalhoBody, AtualizarItensBody, CriarDevolucaoBody, DevolucaoDetalhe, ManualValidado, SaldoResposta } from "../fiscal/devolucao/contrato";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";
import type { NfeDraftItem } from "../interfaces/nfe.interface";
import type { RefDevolucaoItem, SaldoItemOriginal } from "../fiscal/devolucao/tipos";
import type { ContextoEmissaoDevolucao } from "../fiscal/devolucao/emissao";
import { hashConteudo } from "../fiscal/numeracao/decisao";
import { createNfeProvider } from "../fiscal/providers/provider-factory";
import { FocusNfeProvider } from "../fiscal/providers/focus-nfe.provider";
import { NfeNumeracaoService } from "../fiscal/numeracao/numeracao.service";

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
      const aberta=await this.repo.aberta(userId,parsed.chaveAcesso,tx);
      if(aberta)return {draftId:aberta,reutilizado:true};
      const linhasSaldo=await this.repo.linhasSaldo(userId,parsed.chaveAcesso,tx);
      const m=montarRascunhoDeOriginal({original:{...n,companyFiscalConfigId:n.companyFiscalConfigId??null},config:c,parsed,idDestOriginal:parsed.ide.idDest!,linhasSaldo,
        itensNfe:n.itens.map(i=>({...i,productId:i.productId??null})),escopo:body.escopo??"TOTAL",tipo:"VENDA_ENTRADA"});
      const erro=m.issues.find(i=>i.severidade==="ERRO" && ["CHAVE_DIVERGENTE","AMBIENTE_DIVERGENTE","TOTALMENTE_DEVOLVIDA","PARCIALMENTE_DEVOLVIDA","EMITENTE_ORIGINAL_DIVERGENTE"].includes(i.code));
      if(erro)throw new DevolucaoError(erro.code==="TOTALMENTE_DEVOLVIDA"?"TOTALMENTE_DEVOLVIDA":erro.code==="PARCIALMENTE_DEVOLVIDA"?"PARCIALMENTE_DEVOLVIDA":"DEVOLUCAO_INVALIDA",[erro]);
      if(!m.itens.length)throw new DevolucaoError("TOTALMENTE_DEVOLVIDA");
      return {draftId:await this.repo.criar(tx,userId,actorUserId,m),reutilizado:false};
    });
  }
  async manual(userId:string,actorUserId:string,input:ManualValidado) {
    const config=await this.config(userId,input.companyFiscalConfigId);
    const m=montarRascunhoManual(input,config);
    return this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,[m.origem.chaveAcesso]);
      const linhas=await this.repo.linhasSaldo(userId,m.origem.chaveAcesso,tx);
      const saldos=calcularSaldoPorItem({itensOriginais:m.refs.map(r=>({nItem:r.nItemOriginal,quantidade:r.quantidadeOriginal})),linhas,chave:m.origem.chaveAcesso});
      if(m.refs.some(r=>{const saldo=saldos.find(s=>s.nItem===r.nItemOriginal);return saldo?.disponivel!=null && r.quantidade>saldo.disponivel;}))throw new DevolucaoError("SALDO_INSUFICIENTE");
      return {draftId:await this.repo.criar(tx,userId,actorUserId,m,input.modo==="CHAVE",input.devolvidaAposEntrega)};
    });
  }
  async detalhe(userId:string,id:string,db?:FiscalSql):Promise<DevolucaoDetalhe> {
    const n=await this.repo.nota(userId,id,db);if(!n)throw new DevolucaoError("NAO_ENCONTRADA");
    const config=await this.config(userId,n.companyFiscalConfigId);
    const d=await this.repo.get(userId,id,db);if(!d)throw new DevolucaoError("DEVOLUCAO_NAO_GERENCIADA");
    return this.detalhar(d,config,db);
  }
  private async detalhar(d:DevolucaoPersistida,config:CompanyFiscalConfig,db?:FiscalSql):Promise<DevolucaoDetalhe> {
    const {cabecalho:h,nota:n}=d;
    const saldos:Array<SaldoItemOriginal & {chaveAcesso:string}>=[];
    for(const origem of h.origensJson) {
      const linhas=await this.repo.linhasSaldo(h.userId,origem.chaveAcesso,db);
      saldos.push(...calcularSaldoPorItem({itensOriginais:origem.itens.map(i=>({nItem:i.nItem,quantidade:i.quantidade||null})),linhas,chave:origem.chaveAcesso,excluirDevolucaoNfeId:n.id}).map(s=>({...s,chaveAcesso:origem.chaveAcesso})));
    }
    const originais=await (db??this.repo.db).$queryRawUnsafe<Array<{chaveAcesso:string;status:string;ambiente:string}>>(`SELECT regexp_replace("chaveAcesso",'[^0-9]','','g') AS "chaveAcesso","status","ambiente" FROM "NfeEmitida" WHERE "userId"=$1 AND regexp_replace("chaveAcesso",'[^0-9]','','g')=ANY($2::text[])`,h.userId,h.origensJson.map(o=>o.chaveAcesso));
    // Ambiente de EMISSÃO = o da config atual (o orquestrador monta a chave fiscal com ele),
    // não o da linha (ambiente de criação do rascunho): rascunho criado em homologação e
    // emitido depois da troca para produção cai em AMBIENTE_DIVERGENTE.
    const ambienteEmissao=config.ambiente;
    // Regime do emitente: o MESMO `crtDeRegime` que a validação (rejeições 590/591)
    // e o `aplicarOverrideTributacao` de `itens()` usam — por isso sai daqui um só,
    // para a tela nunca recusar o que o servidor aceita, nem aceitar o que ele recusa.
    const emitente=regimeEmitenteDevolucao(config.regimeTributario);
    const issues=validarDevolucao({cabecalho:h,nota:{...n,ambiente:ambienteEmissao,destinatarioCpfCnpj:n.destinatarioJson?.cpfCnpj},emitente:{cnpj:config.cnpj,crt:emitente.crt},itens:n.itens,
      refs:d.refs.map(r=>({...r,chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal})),saldos,originais,idDestOriginal:h.origensJson[0]?.idDest});
    return {draftId:n.id,status:n.status,tipo:h.tipo,fonte:h.fonte,escopo:h.escopoSolicitado,devolvidaAposEntrega:h.devolvidaAposEntrega,confirmadoSemXml:h.confirmadoSemXml,indFinal:h.indFinal,
      modoReferencia:modoReferenciaDevolucao(ambienteEmissao,new Date(),devolucaoRefItemProdDesde()),emitente,
      originais:h.origensJson.map(o=>({...o,destinatarioNome:null})),issues,podeEmitir:!temBloqueio(issues),
      itens:d.refs.map(r=>{
        const item=n.itens.find(i=>i.numero===r.ordem);const s=saldos.find(s=>s.chaveAcesso===r.chaveAcessoOriginal && s.nItem===r.nItemOriginal);
        return {ordem:r.ordem,chaveAcesso:r.chaveAcessoOriginal,nItem:r.nItemOriginal,codigo:item?.codigo??r.codigoOriginal,descricao:item?.descricao??"",unidade:item?.unidade??"",ncm:item?.ncm??"",
          quantidadeOriginal:r.quantidadeOriginal,devolvidaAutorizada:s?.devolvidaAutorizada??0,emProcessamento:s?.emProcessamento??0,disponivel:s?.disponivel??null,quantidade:r.quantidade,valorUnitario:item?.valorUnitario??0,valor:r.valor,
          cfopOriginal:r.cfopOriginal,cfop:item?.cfop??"",cfopStatus:r.cfopMapeamento.status,cfopOpcoes:r.cfopMapeamento.opcoes,tributacao:r.tributacao,requerRevisao:r.tributacao.requerRevisao};
      })};
  }
  async cabecalho(userId:string,actorUserId:string,id:string,body:AtualizarCabecalhoBody) {
    const d=await this.repo.get(userId,id);if(!d)throw new DevolucaoError("DEVOLUCAO_NAO_GERENCIADA");
    await this.config(userId,d.nota.companyFiscalConfigId);
    if(body.tipo && body.tipo!==d.cabecalho.tipo)throw new DevolucaoError("RASCUNHO_ALTERADO");
    await this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,d.cabecalho.origensJson.map(o=>o.chaveAcesso));
      await this.repo.lockRascunho(tx,userId,id);
      await tx.$executeRawUnsafe(`UPDATE "NfeDevolucao" SET "devolvidaAposEntrega"=CASE WHEN $3 THEN $4 ELSE "devolvidaAposEntrega" END,"escopoSolicitado"=COALESCE($5,"escopoSolicitado"),"updatedAt"=GREATEST(NOW(),"updatedAt"+interval '1 millisecond') WHERE "userId"=$1 AND "nfeId"=$2`,userId,id,body.devolvidaAposEntrega!==undefined,body.devolvidaAposEntrega??null,body.escopo??null);
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
      const saldos:Array<SaldoItemOriginal & {chaveAcesso:string}>=[];
      for(const origem of d.cabecalho.origensJson)saldos.push(...calcularSaldoPorItem({itensOriginais:origem.itens.map(i=>({nItem:i.nItem,quantidade:i.quantidade||null})),linhas:await this.repo.linhasSaldo(userId,origem.chaveAcesso,tx),chave:origem.chaveAcesso,excluirDevolucaoNfeId:id}).map(s=>({...s,chaveAcesso:origem.chaveAcesso})));
      if(d.cabecalho.escopoSolicitado==="TOTAL" && saldos.some(s=>s.disponivel!=null && s.disponivel>0 && !body.itens.some(i=>i.chaveAcesso===s.chaveAcesso && i.nItem===s.nItem && i.quantidade===s.disponivel)))throw new DevolucaoError("SALDO_INSUFICIENTE");
      const itens:NfeDraftItem[]=[];const refs:RefDevolucaoItem[]=[];
      for(const b of body.itens.filter(i=>i.quantidade>0)) {
        const origem=d.cabecalho.origensJson.find(o=>o.chaveAcesso===b.chaveAcesso);
        const original=origem?.itens.find(i=>i.nItem===b.nItem);if(!origem || !original)throw new DevolucaoError("ITEM_ORIGINAL_INEXISTENTE");
        const saldo=saldos.find(i=>i.chaveAcesso===b.chaveAcesso && i.nItem===b.nItem);
        if(saldo?.disponivel!=null && b.quantidade>saldo.disponivel)throw new DevolucaoError("SALDO_INSUFICIENTE");
        if(d.cabecalho.escopoSolicitado==="TOTAL" && b.quantidade!==(saldo?.disponivel??original.quantidade))throw new DevolucaoError("SALDO_INSUFICIENTE");
        const tipoOperacao=d.cabecalho.tipo==="COMPRA_SAIDA"?"SAIDA":"ENTRADA";
        if(!isCfopPermitidoEmDevolucao(b.cfop,tipoOperacao==="SAIDA"?"1":"0") || idDestDoCfop(b.cfop)!==origem.idDest)throw new DevolucaoError("CFOP_INVALIDO");
        const crtEmitente=crtDeRegime(config.regimeTributario);
        const base=proporcionalizar({impostoOriginal:d.cabecalho.fonte==="MANUAL"?null:original.impostoOriginal,qOriginal:original.quantidade||null,qDevolvida:b.quantidade,vUnCom:original.valorUnitario,crtEmitente,crtOriginal:origem.crtOriginal,tipoOperacao});
        const anterior=d.refs.find(r=>r.chaveAcessoOriginal===b.chaveAcesso && r.nItemOriginal===b.nItem);
        const t=anterior?.tributacao;
        // `ipiDevol:false` e a escolha de RETIRAR o IPI devolvido: sem reconstrui-la, o proximo save devolvia o IPI.
        const saved=t?.fonte==="USUARIO"?{icms:{cst:t.icms.cst,csosn:t.icms.csosn,modBC:t.icms.modBC,pICMS:t.icms.pICMS},pis:{cst:t.pis.cst,p:t.pis.p},cofins:{cst:t.cofins.cst,p:t.cofins.p},...(t.ipiDevol===null&&base.ipiDevol?{ipiDevol:false as const}:{})}:undefined;
        // Mescla POR TRIBUTO: o que vem no corpo substitui so aquele tributo; os ausentes mantem o que o usuario ja gravou.
        // Era `b.tributacao??saved`: salvar so o ICMS refazia PIS/COFINS a partir do XML do fornecedor (aconteceu na DLS,
        // 24/09 18:24 — PIS 01 a 1,65% voltou a 0% herdado do 04). Nunca mesclar DENTRO do grupo: {cst} novo sobre {csosn}
        // salvo deixaria os dois preenchidos e o CSOSN venceria a escolha dela.
        const override=aplicarOverrideTributacao({base,override:(b.tributacao||saved)?{...(saved??{}),...(b.tributacao??{})}:undefined,confirmar:b.confirmarTributacao,crtEmitente,baseCalculoItem:round2(b.quantidade*original.valorUnitario),tipoOperacao});
        if(!override.ok)throw new DevolucaoError("TRIBUTACAO_NAO_SUPORTADA");
        const ordem=itens.length+1;const valor=round2(b.quantidade*original.valorUnitario);
        itens.push({numero:ordem,codigo:original.codigo,descricao:original.descricao,ncm:original.ncm,cest:original.cest,cfop:b.cfop,unidade:original.unidade,origem:(original.origem??0) as NfeDraftItem["origem"],quantidade:b.quantidade,valorUnitario:original.valorUnitario,valorTotal:valor,desconto:original.quantidade?round2(original.desconto*b.quantidade/original.quantidade):0});
        refs.push({ordem,originalNfeId:origem.originalNfeId,chaveAcessoOriginal:origem.chaveAcesso,nItemOriginal:original.nItem,codigoOriginal:original.codigo,cfopOriginal:original.cfop,quantidadeOriginal:original.quantidade||null,valorUnitarioOriginal:original.valorUnitario,quantidade:b.quantidade,valor,impostoOriginal:original.impostoOriginal,tributacao:override.tributacao,cfopMapeamento:mapearCfopDevolucao({cfopOriginal:original.cfop,tipo:d.cabecalho.tipo,idDestOriginal:origem.idDest,crt:crtEmitente})});
      }
      if(!itens.length)throw new DevolucaoError("PAYLOAD_INVALIDO");
      await this.repo.gravarItens(tx,userId,id,itens,refs);
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
  async registrarAutorizacao(userId:string,id:string):Promise<void> {
    const before=await this.repo.get(userId,id);if(!before)return;
    await this.repo.transaction(async tx=>{
      await this.repo.lockOrigens(tx,userId,before.cabecalho.origensJson.map(o=>o.chaveAcesso));
      for(const r of before.refs) {
        if(r.originalNfeId)await this.repo.audit(tx,userId,r.originalNfeId,"DEVOLUCAO_VINCULADA",{devolucaoNfeId:id,nItem:r.nItemOriginal,quantidade:r.quantidade});
        const linhas=await this.repo.linhasSaldo(userId,r.chaveAcessoOriginal,tx);
        const quantidade=linhas.filter(l=>l.nItem===r.nItemOriginal && l.statusDevolucao==="AUTHORIZED").reduce((s,l)=>s+Number(l.quantidade),0);
        if(r.quantidadeOriginal!=null && quantidade>r.quantidadeOriginal)await this.repo.audit(tx,userId,id,"DEVOLUCAO_SALDO_EXCEDIDO",{chave:r.chaveAcessoOriginal,nItem:r.nItemOriginal,quantidade});
      }
      await this.repo.audit(tx,userId,id,"DEVOLUCAO_AUTORIZADA",{originais:before.cabecalho.origensJson.map(o=>o.chaveAcesso)});
    });
  }
}

import prisma from "../lib/prisma";
import type { NfeDraftResponse } from "../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";
import type { EmissionResult } from "./nfe-emission.usecase";
import { NfeNumeracaoService } from "../fiscal/numeracao/numeracao.service";
import type { ResultadoFiscal } from "../fiscal/numeracao/numeracao.service";
import { NumeracaoError } from "../fiscal/numeracao/numeracao.errors";
import { decidirEntrada, decidirPreClaim, decidirReadbackFocus, hashConteudo, partesDaChave } from "../fiscal/numeracao/decisao";
import { classificarEnvioSefaz, classificarConsultaSefaz, classificarPostFocus, classificarGetFocus, extrairChaveReferida } from "../fiscal/numeracao/classificacao";
import type { Reserva, Tentativa, NumeracaoTx } from "../fiscal/numeracao/persistencia";
import type { FocusV2Resposta } from "../fiscal/numeracao/tipos";
import { consumoIndevidoCooldownMs, cooldownRepeticaoMs, focusPausasConsultaMs, leasePreEnvioMs, leaseEnvioSefazMs, leaseEnvioFocusMs, naoConstaMinMs, isDevolucaoAtiva } from "../fiscal/flags";
import { FiscalStorageService } from "../fiscal/storage/fiscal-storage.service";
import { SefazDirectProvider } from "../fiscal/providers/sefaz-direct.provider";
import { FocusNfeV2Client } from "../fiscal/providers/focus-nfe-v2.client";
import { createNfeProviderFromConfig } from "../fiscal/providers/provider-factory";
import { respTecParaPayloadSefaz } from "../fiscal/providers/nfe-provider-resolver";
import { resolverRespTecEmpresa } from "./company-fiscal-resp-tec.usecase";
import { NfeXmlBuilderService } from "../fiscal/generators/nfe-xml-builder.service";
import { FiscalCalculatorService } from "../fiscal/calculators/fiscal-calculator.service";
import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { isNfeFreteMedidasEnabled } from "../fiscal/domain/frete";
import type { NfeItemInput, RegimeTributario } from "../fiscal/domain/nfe.types";
import { NfeDevolucaoUseCase } from "./nfe-devolucao.usecase";
import { calcularDevolucao, decorarFocusDevolucao } from "../fiscal/devolucao/emissao";
import { logNumeracao } from "../fiscal/numeracao/log";

export interface EmitOpts { confirmarDescarteNumero?:boolean; actorUserId?:string }
export interface NumeracaoMetadata {estado:string;numero:number;serie:number;mantido:boolean;reutilizavel:boolean;ambiente:string;companyFiscalConfigId:string}
export const metadadosNumeracao=(r:Reserva,mantido=true):NumeracaoMetadata=>({estado:r.estado,numero:r.numero,serie:r.serie,mantido,reutilizavel:["RESERVADO","REJEITADO"].includes(r.estado),ambiente:r.ambiente,companyFiscalConfigId:r.companyFiscalConfigId});
interface Hooks {
  validar(d:NfeDraftResponse,c:CompanyFiscalConfig):void;
  snapshot(c:CompanyFiscalConfig):unknown;
  autorizado(d:NfeDraftResponse,c:CompanyFiscalConfig,r:ResultadoFiscal,xml:string|null,focusRef?:string|null):Promise<EmissionResult>;
}

/** The transport is entered only after the durable attempt and its lease exist. */
export class NfeEmissaoV2Orchestrator {
  constructor(private readonly hooks:Hooks,readonly numeros=new NfeNumeracaoService(),private readonly repo=new NfeRepository(),private readonly storage=new FiscalStorageService()) {}
  private async resposta(userId:string,id:string,mensagem:string,mantido=true):Promise<EmissionResult> {
    // Qualquer status: a resposta da V2 descreve notas SENDING (incerto/em andamento) e AUTHORIZED (replay).
    const d=await this.repo.findNfeById(userId,id);if(!d)throw new NumeracaoError("NFE_NAO_ENCONTRADA",404,"Nota não encontrada");
    const r=await this.numeros.reservaViva(userId,id);
    const fiscal=d.status==="AUTHORIZED"?partesDaChave(d.chaveAcesso):null;
    return {success:d.status==="AUTHORIZED",nfeId:id,status:d.status,numero:d.numero,serie:d.serie,chaveAcesso:d.chaveAcesso??null,protocolo:(await prisma.$queryRawUnsafe<Array<{protocoloAutorizacao:string|null}>>('SELECT "protocoloAutorizacao" FROM "NfeEmitida" WHERE "id"=$1 AND "userId"=$2',id,userId))[0]?.protocoloAutorizacao??null,mensagem,
      // `numeracao` sempre presente (null sem reserva viva): o front limpa o "nº mantido" de números já consumidos.
      ...(fiscal?{numero:Number(fiscal.nNF),serie:Number(fiscal.serie)}:{}),emAndamento:["VALIDATING","SIGNING","SENDING"].includes(d.status) || !!r && ["INCERTO","EM_TRANSMISSAO"].includes(r.estado),numeracao:r?metadadosNumeracao(r,mantido):null};
  }
  async emitir(userId:string,draft:NfeDraftResponse,config:CompanyFiscalConfig,opts:EmitOpts={}):Promise<EmissionResult> {
    const id=draft.id;const viva=await this.numeros.reservaViva(userId,id);
    const entrada=decidirEntrada({status:draft.status,updatedAt:new Date(draft.updatedAt),viva,agora:new Date(),leasePreEnvioMs:leasePreEnvioMs(),numero:draft.numero});
    if(entrada.acao==="RECONCILIAR")return this.consultar(userId,draft,config);
    if(entrada.acao==="REPLAY_AUTORIZADA"){await this.completarPosAutorizacao(userId,id,config);return this.resposta(userId,id,entrada.mensagem);}
    if(entrada.acao==="EM_ANDAMENTO")return this.resposta(userId,id,entrada.mensagem);
    if(entrada.acao==="BLOQUEADA_MANUAL")throw new NumeracaoError("NUMERACAO_BLOQUEADA",409,entrada.mensagem);
    if(entrada.acao==="DELEGAR_V1")throw new NumeracaoError("NFE_NAO_EMITIVEL",409,"Esta nota não pode ser emitida");
    const dev=new NfeDevolucaoUseCase();
    const devolucao=draft.finalidade==="DEVOLUCAO" && isDevolucaoAtiva(config.id)?await dev.contextoEmissao(userId,id):null;
    this.hooks.validar(draft,config);
    const respTec=config.providerName==="SEFAZ_DIRECT"?respTecParaPayloadSefaz(await resolverRespTecEmpresa(config)):undefined;
      let calculada:NfeDraftResponse;
      if(devolucao)calculada=calcularDevolucao(draft,devolucao.contexto);
      else {
        const regime=config.regimeTributario as RegimeTributario;
        const inputs:NfeItemInput[]=draft.itens.map(i=>({...i,quantidade:Number(i.quantidade),valorUnitario:Number(i.valorUnitario),desconto:Number(i.desconto??0),aliquotaIcms:i.aliquotaIcms??null,aliquotaIpi:i.aliquotaIpi??null,aliquotaPis:i.aliquotaPis??null,aliquotaCofins:i.aliquotaCofins??null,reducaoBcIcms:i.reducaoBcIcms??null,origem:i.origem??0,cstIcms:i.cstIcms??(regime==="SIMPLES"?"102":"00"),cstPis:i.cstPis??(regime==="SIMPLES"?"49":"01"),cstCofins:i.cstCofins??(regime==="SIMPLES"?"49":"01")}));
        const calc=new FiscalCalculatorService().calcular(regime,inputs,isNfeFreteMedidasEnabled() && draft.modelo!=="65"?{valorFrete:draft.valorFrete??0,modalidadeFrete:draft.modalidadeFrete??null}:undefined);
        calculada={...draft,itens:draft.itens.map((i,index)=>({...i,tributosJson:calc.itens[index]})),totaisJson:calc.totais};
      }

    const conteudoSha256=hashConteudo({draft:{...calculada,companyFiscalConfigId:config.id,ambiente:config.ambiente,emitenteJson:this.hooks.snapshot(config)},devolucao:devolucao?.contexto,respTec});
    const key={cfc:config.id,ambiente:config.ambiente,modelo:draft.modelo??"55",serie:draft.serie};
    const pre=decidirPreClaim({viva,key,conteudoSha256,ultimaTentativa:viva?(await this.numeros.tentativas(userId,viva.id))[0]??null:null,confirmarDescarte:opts.confirmarDescarteNumero===true,agora:new Date(),cooldownMs:cooldownRepeticaoMs()});
    if(pre.acao==="CONFIRMAR_DESCARTE")throw new NumeracaoError("NUMERACAO_CONFIRMAR_DESCARTE",409,pre.mensagem,pre.detalhes);
    if(pre.acao==="COOLDOWN")throw new NumeracaoError("NUMERACAO_REPETICAO",409,pre.mensagem,{retryAposMs:pre.retryAposMs});
    const claimEm=new Date();
    const claimed=await prisma.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "status"='VALIDATING',"updatedAt"=$6,"motivoRejeicao"=NULL WHERE "id"=$1 AND "userId"=$2 AND "updatedAt"=$3 AND ("status" IN ('DRAFT','REJECTED') OR ($4 AND "status" IN ('VALIDATING','SIGNING') AND "updatedAt"<$5))`,id,userId,new Date(draft.updatedAt),entrada.acao==="RETOMAR_TRAVADA",new Date(Date.now()-leasePreEnvioMs()),claimEm);
    if(!claimed)return this.resposta(userId,id,"Emissão desta NF-e já está em andamento");
    let enviada=false;
    try {
      const validarNaTransacao=devolucao?async(tx:NumeracaoTx)=>{
        if(!tx.sql)throw new Error("Transação fiscal indisponível");
        await dev.validarReserva(userId,id,devolucao.dados,tx.sql);
      }:undefined;
      const reserva=await this.numeros.reservarOuReutilizar({actorUserId:opts.actorUserId,claimEm,calculo:calculada,userId,nfeId:id,key,isDefault:config.isDefault===true,row:{...draft,companyFiscalConfigId:draft.companyFiscalConfigId??null},providerName:config.providerName==="SEFAZ_DIRECT"?"SEFAZ_DIRECT":"FOCUS_NFE",confirmarDescarte:opts.confirmarDescarteNumero,cnpjEmitente:config.cnpj,emitenteSnapshot:this.hooks.snapshot(config)},validarNaTransacao);
      calculada={...calculada,numero:reserva.numero,ambiente:config.ambiente,companyFiscalConfigId:config.id};
      logNumeracao("reserva",{userId,nfeId:id,reservaId:reserva.id,numero:reserva.numero,serie:reserva.serie,origem:reserva.origemDecisao});
      const provider=await createNfeProviderFromConfig(config);
      if(provider instanceof SefazDirectProvider) {
        const p=provider.prepararEmissao({draft:calculada,config,numero:reserva.numero,cNF:reserva.cNF!,dhEmi:new Date(),respTec,...(devolucao?{devolucao:devolucao.contexto}:{})});
        const path=await this.storage.saveXmlTentativa(userId,id,reserva.numero,p.signedXml);
        const ativo=await this.numeros.iniciarTransmissao(reserva,{provedor:"SEFAZ_DIRECT",chaveAcesso:p.chaveAcesso,dhEmi:p.dhEmi,digestValue:p.digestValue,xmlAssinadoPath:path,conteudoSha256,focusRef:null},leaseEnvioSefazMs());
        enviada=true;
        const raw=await provider.transmitirPreparada(p);
        const result:ResultadoFiscal={classificacao:classificarEnvioSefaz(raw,{consumoIndevidoCooldownMs:consumoIndevidoCooldownMs()}),chaveAcesso:raw.chNFe??p.chaveAcesso,protocolo:raw.nProt,dataAutorizacao:raw.dhRecbto??undefined,httpStatus:raw.httpStatus,transporte:raw.transporte,nRec:raw.nRec};
        const r=await this.numeros.registrarResposta(ativo.reserva,ativo.tentativa,result);
        if(r.estado==="AUTORIZADO")return this.finalizar(userId,calculada,config,result,raw.xmlAutorizado);
        if(result.classificacao.acao!=="NENHUMA")return this.consultar(userId,calculada,config);
        return this.resposta(userId,id,result.classificacao.mensagem,reserva.origemDecisao!=="CONTADOR");
      }
      if(!config.providerToken)throw new NumeracaoError("PROVEDOR_SEM_TOKEN",422,"Token do provedor não configurado");
      // Um instante por tentativa: vai no payload (data_emissao, obrigatório na Focus), na tentativa e na nota.
      const dhEmi=new Date();
      let payload=new NfeXmlBuilderService().build({...calculada,dataEmissao:dhEmi},config,reserva.numero) as Record<string,unknown>;
      payload.numero=String(reserva.numero);payload.serie=String(reserva.serie);
      if(devolucao)payload=decorarFocusDevolucao(payload,devolucao.contexto);
      const focusRef=await this.numeros.focusRefPara(userId,id,reserva);
      const ativo=await this.numeros.iniciarTransmissao(reserva,{provedor:"FOCUS_NFE",chaveAcesso:null,dhEmi,digestValue:null,xmlAssinadoPath:null,conteudoSha256,focusRef},leaseEnvioFocusMs());
      enviada=true;
      const raw=await new FocusNfeV2Client(config.ambiente,draft.modelo==="65"?"65":"55").emitir(payload,focusRef,config.providerToken);
      const result=this.focusResultado(raw,false,ativo.tentativa);
      const r=await this.registrarFocus(ativo.reserva,ativo.tentativa,result,config,false);
      if(r.estado==="AUTORIZADO")return this.finalizar(userId,calculada,config,result,null,focusRef);
      if(result.classificacao.acao==="POLL_REF")return this.acompanharFocus(userId,calculada,config);
      if(result.classificacao.acao!=="NENHUMA")return this.consultar(userId,calculada,config);
      return this.resposta(userId,id,result.classificacao.mensagem,reserva.origemDecisao!=="CONTADOR");
    } catch(error) {
      if(!enviada)await prisma.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "status"='DRAFT',"updatedAt"=NOW() WHERE "userId"=$1 AND "id"=$2 AND "status" IN ('VALIDATING','SIGNING') AND "updatedAt"=$3`,userId,id,claimEm);
      // A late response loses its fencing token; the new owner decides the result.
      if(enviada && error instanceof NumeracaoError && error.code==="NUMERACAO_CONCORRENCIA")return this.resposta(userId,id,"Resultado em reconciliação — consulte a situação");
      throw error;
    }
  }
  async consultar(userId:string,draft:NfeDraftResponse,config:CompanyFiscalConfig):Promise<EmissionResult> {
    const viva=await this.numeros.reservaViva(userId,draft.id);
    if(viva?.estado==="AUTORIZADO")await this.completarPosAutorizacao(userId,draft.id,config);
    if(!viva || !["EM_TRANSMISSAO","INCERTO"].includes(viva.estado))return this.resposta(userId,draft.id,viva?.motivo??"Nenhum envio pendente de consulta");
    let r=await this.numeros.tomarLease(userId,viva.id,leaseEnvioSefazMs());
    if(!r)return this.resposta(userId,draft.id,"Emissão ou consulta em andamento");
    try {
      const ts=await this.numeros.tentativas(userId,r.id);
      for(const t of ts.filter(t=>t.fase!=="FECHADA")) {
        // Resolve credentials from the original issuer; preserve the attempt's provider and environment.
        const atual=await new CompanyFiscalRepository().findByIdForUser(r.companyFiscalConfigId,userId);
        if(!atual)throw new NumeracaoError("EMITENTE_AUSENTE",409,"Emitente da tentativa não encontrado");
        const c={...atual,ambiente:t.ambiente as CompanyFiscalConfig["ambiente"],providerName:t.provedor};
        let result:ResultadoFiscal;let xml:string|null=null;
        if(t.provedor==="FOCUS_NFE") {
          const raw=await new FocusNfeV2Client(c.ambiente,r.modelo==="65"?"65":"55").consultar(t.focusRef!,c.providerToken??"");
          result=this.focusResultado(raw,true,t);
          if(result.classificacao.classe==="DUPLICIDADE_OUTRA_CHAVE") {
            // 539/562/613: a SEFAZ diz que o número já existe com OUTRA chave. A ref da Focus não muda de
            // status, então sem decisão aqui a nota ficaria INCERTO para sempre.
            const referida=result.classificacao.chaveReferida??null;
            const partes=partesDaChave(referida);
            const mesmaIdentidade=!!partes && partes.CNPJ===c.cnpj.replace(/\D/g,"") && partes.mod===r.modelo && Number(partes.serie)===r.serie && Number(partes.nNF)===r.numero;
            const nossa=!!referida && ts.some(at=>at.chaveAcesso===referida);
            result.classificacao=!mesmaIdentidade || nossa
              ?{...result.classificacao,estadoAlvo:"BLOQUEADO",conclusiva:false,mensagem:"Duplicidade sem chave fiscal consistente — conferência manual"}
              :{...result.classificacao,estadoAlvo:"CONSUMIDO_EXTERNO",conclusiva:true,chaveReferida:referida,mensagem:`Nº ${r.numero} já usado na SEFAZ pela chave ${referida} — confira se é uma NF-e desta empresa antes de reemitir`};
          }
          r=await this.registrarFocus(r,t,result,c,true);
        } else {
          const provider=await createNfeProviderFromConfig(c);
          if(!(provider instanceof SefazDirectProvider))throw new Error("Provedor incompatível");
          const referida=t.classe==="DUPLICIDADE_OUTRA_CHAVE"?extrairChaveReferida(t.mensagem):null;
          const raw=t.nRec?await provider.consultarReciboDetalhado(t.nRec,t.chaveAcesso!):await provider.consultarDetalhado(referida??t.chaveAcesso!);
          result={classificacao:classificarConsultaSefaz(raw,{chavesNossas:ts.flatMap(t=>t.chaveAcesso?[t.chaveAcesso]:[]),digestsNossos:ts.flatMap(t=>t.digestValue?[t.digestValue]:[]),madura:Date.now()-t.transmitidaEm.getTime()>=naoConstaMinMs()},{consumoIndevidoCooldownMs:consumoIndevidoCooldownMs()}),protocolo:raw.nProt,chaveAcesso:raw.chNFe,dataAutorizacao:raw.dhRecbto??undefined,httpStatus:raw.httpStatus,transporte:raw.transporte};
          if(t.classe==="DUPLICIDADE_OUTRA_CHAVE") {
            const partes=partesDaChave(referida);
            const mesmaIdentidade=partes && partes.CNPJ===c.cnpj.replace(/\D/g,"") && partes.mod===r.modelo && Number(partes.serie)===r.serie && Number(partes.nNF)===r.numero;
            const nossa=ts.some(at=>at.chaveAcesso===referida);
            // O cStat da duplicidade veio no ENVIO (`t.cStat`, ex.: 613) — a resposta da CONSULTA
            // traz outro (217 "não consta", p.ex.) e sobrescreveria a tentativa, apagando o único
            // código que explica a retenção. Preserva-se o real; nada é inventado. No ramo da Focus
            // a duplicidade vem na própria consulta, então lá `result.classificacao.cStat` já é ele.
            const cStatDuplicidade=t.cStat??result.classificacao.cStat;
            if(!referida || !mesmaIdentidade)result.classificacao={...result.classificacao,estadoAlvo:"BLOQUEADO",conclusiva:false,classe:"DUPLICIDADE_OUTRA_CHAVE",cStat:cStatDuplicidade,mensagem:`Duplicidade sem chave fiscal consistente (cStat ${cStatDuplicidade}) — conferência manual`};
            else if(!nossa && raw.transporte===null && [100,150,101,151,155,110,301,302,303].includes(raw.cStat??0) && raw.nProt && raw.chNFe===referida)result.classificacao={...result.classificacao,estadoAlvo:"CONSUMIDO_EXTERNO",conclusiva:true,mensagem:"Número registrado na SEFAZ por outro documento"};
            else if(!nossa)result.classificacao={...result.classificacao,classe:"DUPLICIDADE_OUTRA_CHAVE",chaveReferida:referida,estadoAlvo:null,conclusiva:false,mensagem:"Duplicidade ainda sem confirmação — consulte novamente"};
          }
          r=await this.numeros.registrarConsulta(r,t,result);
          // Depois do commit AUTORIZADO nada pode virar 500: sem o XML assinado, a pós-autorização segue sem nfeProc.
          if(r.estado==="AUTORIZADO" && raw.protNFeXml && t.xmlAssinadoPath){try{const signed=await this.storage.readFile(t.xmlAssinadoPath);if(signed)xml=SefazDirectProvider.montarNfeProc(signed.toString("utf8"),raw.protNFeXml);}catch{xml=null;}}
        }
        if(r.estado==="AUTORIZADO")return this.finalizar(userId,draft,c,result,xml,t.focusRef);
        if(!["INCERTO","EM_TRANSMISSAO"].includes(r.estado))return this.resposta(userId,draft.id,result.classificacao.mensagem);
      }
      if(!(await this.numeros.tentativasAbertas(userId,r.id)).length)r=await this.numeros.naoConstaConfirmado(r);
      else r=await this.numeros.devolverIncerto(r);
      return this.resposta(userId,draft.id,r.motivo??"Resultado ainda incerto — consulte novamente em alguns minutos");
    } catch(error) {
      try{await this.numeros.devolverIncerto(r);}catch{/* A different lease owner may already have committed. */}
      throw error;
    }
  }
  private focusResultado(raw:FocusV2Resposta,consulta:boolean,t:Tentativa):ResultadoFiscal {
    // data_recebimento só vem na consulta completa; sem ela a data da autorização é a do registro.
    const recebida=raw.corpo?.data_recebimento?new Date(raw.corpo.data_recebimento):null;
    return {classificacao:consulta?classificarGetFocus(raw,{madura:Date.now()-t.transmitidaEm.getTime()>=naoConstaMinMs(),postConclusivo:t.prova==="RESPOSTA_CONCLUSIVA"},{consumoIndevidoCooldownMs:consumoIndevidoCooldownMs()}):classificarPostFocus(raw,{consumoIndevidoCooldownMs:consumoIndevidoCooldownMs()}),chaveAcesso:raw.corpo?.chave_nfe,protocolo:raw.corpo?.protocolo??raw.corpo?.protocolo_sefaz,dataAutorizacao:recebida && Number.isFinite(recebida.getTime())?recebida:undefined,httpStatus:raw.httpStatus,transporte:raw.transporte};
  }
  /** NF-e 55 na Focus é assíncrona: depois do 202, algumas consultas curtas antes de devolver "em andamento". */
  private async acompanharFocus(userId:string,draft:NfeDraftResponse,config:CompanyFiscalConfig):Promise<EmissionResult> {
    const pausas=focusPausasConsultaMs();
    if(!pausas.length)return this.consultar(userId,draft,config);
    let res:EmissionResult|null=null;
    for(const ms of pausas) {
      await new Promise(resolve=>setTimeout(resolve,ms));
      res=await this.consultar(userId,draft,config);
      if(!res.emAndamento)break;
    }
    return res!;
  }
  /**
   * Nota AUTHORIZED pela V2 cuja pós-autorização (XML/DANFE/auditoria AUTORIZADA) não concluiu:
   * refaz o hook. A marca de conclusão é o evento AUTORIZADA, gravado no fim de handleAuthorized.
   */
  private async completarPosAutorizacao(userId:string,id:string,config:CompanyFiscalConfig):Promise<void> {
    try {
      const r=await this.numeros.reservaViva(userId,id);
      if(!r || r.estado!=="AUTORIZADO")return;
      const feito=await prisma.$queryRawUnsafe<Array<{x:number}>>(`SELECT 1 AS x FROM "NfeAuditLog" WHERE "nfeId"=$1 AND "userId"=$2 AND "evento"='AUTORIZADA' LIMIT 1`,id,userId);
      if(feito.length)return;
      const d=await this.repo.findNfeById(userId,id);
      if(!d || d.status!=="AUTHORIZED" || !d.chaveAcesso)return;
      const row=(await prisma.$queryRawUnsafe<Array<{protocoloAutorizacao:string|null;dataAutorizacao:Date|null}>>('SELECT "protocoloAutorizacao","dataAutorizacao" FROM "NfeEmitida" WHERE "id"=$1 AND "userId"=$2',id,userId))[0];
      const focusRef=config.providerName==="SEFAZ_DIRECT"?null:await this.numeros.focusRefAutorizada(userId,id);
      const result={classificacao:{classe:"AUTORIZADA",estadoAlvo:"AUTORIZADO",acao:"NENHUMA",cStat:100,codigoProvedor:null,conclusiva:true,chaveReferida:null,retryAposMs:null,mensagem:"NF-e autorizada"},chaveAcesso:d.chaveAcesso,protocolo:row?.protocoloAutorizacao??null,dataAutorizacao:row?.dataAutorizacao??undefined} as unknown as ResultadoFiscal;
      await this.hooks.autorizado(d,config,result,null,focusRef);
    } catch(error) {
      logNumeracao("pos_autorizacao_pendente",{userId,nfeId:id,motivo:error instanceof Error?error.message.slice(0,200):"erro"},"error");
    }
  }
  private async registrarFocus(r:Reserva,t:Tentativa,result:ResultadoFiscal,c:CompanyFiscalConfig,consulta:boolean):Promise<Reserva> {
    if(result.classificacao.estadoAlvo==="AUTORIZADO") {
      const readback=decidirReadbackFocus({reservado:r,chave44:result.chaveAcesso??null,cnpjConfig:c.cnpj,modelo:r.modelo==="65"?"65":"55"});
      if(readback.resultado==="INCONSISTENTE")result.classificacao={...result.classificacao,estadoAlvo:"BLOQUEADO",mensagem:"Chave autorizada incompatível com o emitente ou modelo — conferência manual"};
      else if(readback.resultado==="DIVERGENTE")return this.numeros.registrarReadbackFocus(r,t,result,readback,c.isDefault===true);
    }
    return consulta?this.numeros.registrarConsulta(r,t,result):this.numeros.registrarResposta(r,t,result);
  }
  private async finalizar(userId:string,draft:NfeDraftResponse,c:CompanyFiscalConfig,result:ResultadoFiscal,xml:string|null,focusRef?:string|null):Promise<EmissionResult> {
    // A linha já foi gravada AUTHORIZED por registrarResposta/registrarConsulta.
    const atual=await this.repo.findNfeById(userId,draft.id);if(!atual)throw new Error("Nota não encontrada");
    const real=partesDaChave(result.chaveAcesso);
    // A NF-e já está autorizada (commit feito): falha aqui não desfaz nada, fica marcada e é refeita
    // na próxima consulta/replay (completarPosAutorizacao).
    let pendente=false;
    try{await this.hooks.autorizado({...atual,...(real?{numero:Number(real.nNF),serie:Number(real.serie)}:{})},c,result,xml,focusRef);}
    catch(error){
      pendente=true;
      const motivo=error instanceof Error?error.message.slice(0,200):"erro";
      logNumeracao("pos_autorizacao_pendente",{userId,nfeId:draft.id,motivo},"error");
      try{await this.repo.addAuditLog(draft.id,userId,"POS_AUTORIZACAO_PENDENTE",{motivo});}catch{/* a marca durável é a ausência do evento AUTORIZADA */}
    }
    if(atual.finalidade==="DEVOLUCAO" && isDevolucaoAtiva(c.id))try{await new NfeDevolucaoUseCase().registrarAutorizacao(userId,draft.id);}catch{logNumeracao("devolucao_pos_autorizacao_pendente",{userId,nfeId:draft.id},"error");}
    return this.resposta(userId,draft.id,pendente?"NF-e autorizada — XML/DANFE pendentes; use Consultar situação para concluir":"NF-e autorizada");
  }
}

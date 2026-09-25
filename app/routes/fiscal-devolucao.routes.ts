import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authMiddleware } from "../middlewares/auth.middleware";
import { NfeDevolucaoUseCase } from "../usecases/nfe-devolucao.usecase";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { isDevolucaoAtiva } from "../fiscal/flags";
import { DevolucaoError } from "../fiscal/devolucao/devolucao.errors";
import { NumeracaoError, tabelaFiscalAusente } from "../fiscal/numeracao/numeracao.errors";
import { parseCriarDevolucaoBody, parseAtualizarCabecalhoBody, parseAtualizarItensBody, parseManualBody, respostaErroDevolucao } from "../fiscal/devolucao/contrato";
import type { ErroCampo } from "../fiscal/devolucao/contrato";

/**
 * Recusa de campo com o ITEM da nota original a que ela se refere. `campo` indexa o corpo
 * como foi ENVIADO ("itens[1].tributacao.pis.cst"), e a tela filtra as peças zeradas antes
 * de enviar: o índice não bate com o cartão que ela vê. Com `nItem` (e a chave, no PUT dos
 * itens) a tela acha a peça sem refazer o filtro. Aditivo: `campo` e `mensagem` não mudam.
 */
export function comItemDoCorpo(erros:ErroCampo[],corpo:unknown):Array<ErroCampo & {nItem?:number;chaveAcesso?:string}> {
  const itens=corpo && typeof corpo==="object" && Array.isArray((corpo as {itens?:unknown}).itens)?(corpo as {itens:unknown[]}).itens:null;
  if(!itens)return erros;
  return erros.map(e=>{
    const m=/^itens\[(\d+)\]/.exec(e.campo);const bruto=m?itens[Number(m[1])]:null;
    if(!bruto || typeof bruto!=="object")return e;
    const {nItem,chaveAcesso}=bruto as {nItem?:unknown;chaveAcesso?:unknown};
    return {...e,...(typeof nItem==="number" && Number.isInteger(nItem)?{nItem}:{}),...(typeof chaveAcesso==="string"?{chaveAcesso}:{})};
  });
}

export async function fiscalDevolucaoRoutes(app: FastifyInstance) {
  const uc=new NfeDevolucaoUseCase();
  app.get("/nfe/devolucao/disponibilidade",{preHandler:[authMiddleware]},async(req,reply)=>{
    const user=(req as FastifyRequest & {user:{dataOwnerId:string}}).user;
    const companies=await new CompanyFiscalRepository().findByUserId(user.dataOwnerId);
    return companies && isDevolucaoAtiva(companies.id)?reply.send({disponivel:true,companyFiscalConfigId:companies.id}):reply.code(404).send({error:"Recurso indisponível"});
  });
  // Um envelope só para toda recusa da devolução: { error, code, issues?, erros?, draftId? }
  // (respostaErroDevolucao) — o do 400 do parser e o dos erros do caso de uso são o MESMO.
  const handle=(action:(u:string,a:string,id:string,b:unknown,reply:FastifyReply)=>Promise<unknown>)=>async(req:FastifyRequest,reply:FastifyReply)=>{
    const user=(req as FastifyRequest & {user:{id:string;dataOwnerId:string}}).user;
    try{return await action(user.dataOwnerId,user.id,(req.params as {id?:string}).id??"",req.body,reply);}
    catch(e){
      if(e instanceof DevolucaoError){const r=respostaErroDevolucao(e.code,{mensagem:e.message,issues:e.issues,erros:e.erros?comItemDoCorpo(e.erros,req.body):undefined,draftId:e.draftId});return reply.code(e.httpStatus).send(r.body);}
      if(e instanceof NumeracaoError)return reply.code(e.httpStatus).send({error:e.message,...(e.httpStatus===404?{}:{code:e.code})});
      if(tabelaFiscalAusente(e))return reply.code(404).send({error:"Recurso indisponível"});
      return reply.code(500).send({error:"Não foi possível concluir a operação de devolução"});
    }
  };
  const invalid=(reply:FastifyReply,erros:ErroCampo[],corpo:unknown)=>{const r=respostaErroDevolucao("PAYLOAD_INVALIDO",{erros:comItemDoCorpo(erros,corpo)});return reply.code(r.status).send(r.body);};
  app.post("/nfe/:id/devolucao",{preHandler:[authMiddleware]},handle(async(u,a,id,b,r)=>{const p=parseCriarDevolucaoBody(b);if(!p.ok)return invalid(r,p.erros,b);const result=await uc.criar(u,a,id,p.value);return r.code(result.reutilizado?200:201).send(result);}));
  app.get("/nfe/:id/devolucao/saldo",{preHandler:[authMiddleware]},handle(async(u,_a,id)=>uc.saldo(u,id)));
  // Rascunhos de devolução em aberto (com e sem cabeçalho), para listar, continuar e descartar.
  app.get("/nfe/devolucao/abertas",{preHandler:[authMiddleware]},handle(async(u)=>uc.abertas(u)));
  app.get("/nfe/draft/:id/devolucao",{preHandler:[authMiddleware]},handle(async(u,_a,id)=>uc.detalhe(u,id)));
  app.put("/nfe/draft/:id/devolucao",{preHandler:[authMiddleware]},handle(async(u,a,id,b,r)=>{const p=parseAtualizarCabecalhoBody(b);return p.ok?uc.cabecalho(u,a,id,p.value):invalid(r,p.erros,b);}));
  app.put("/nfe/draft/:id/devolucao/itens",{preHandler:[authMiddleware]},handle(async(u,a,id,b,r)=>{const p=parseAtualizarItensBody(b);return p.ok?uc.itens(u,a,id,p.value):invalid(r,p.erros,b);}));
  // Prévia do manual (itens + saldo + CFOP sugerido + rascunho aberto), sem criar nada. Mesmo corpo do POST abaixo.
  app.post("/nfe/devolucao/manual/previa",{preHandler:[authMiddleware],bodyLimit:1_200_000},handle(async(u,_a,_id,b,r)=>{const p=parseManualBody(b);return p.ok?uc.previaManual(u,p.value):invalid(r,p.erros,b);}));
  // 201 = rascunho novo; 200 com `reutilizado: true` = já havia um aberto desta nota (mesmo tipo).
  app.post("/nfe/devolucao/manual",{preHandler:[authMiddleware],bodyLimit:1_200_000},handle(async(u,a,_id,b,r)=>{const p=parseManualBody(b);if(!p.ok)return invalid(r,p.erros,b);const result=await uc.manual(u,a,p.value);return r.code(result.reutilizado?200:201).send(result);}));
}

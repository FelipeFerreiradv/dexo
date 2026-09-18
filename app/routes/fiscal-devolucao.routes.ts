import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authMiddleware } from "../middlewares/auth.middleware";
import { NfeDevolucaoUseCase } from "../usecases/nfe-devolucao.usecase";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { isDevolucaoAtiva } from "../fiscal/flags";
import { DevolucaoError } from "../fiscal/devolucao/devolucao.errors";
import { NumeracaoError, tabelaFiscalAusente } from "../fiscal/numeracao/numeracao.errors";
import { parseCriarDevolucaoBody, parseAtualizarCabecalhoBody, parseAtualizarItensBody, parseManualBody, respostaErroDevolucao } from "../fiscal/devolucao/contrato";

export async function fiscalDevolucaoRoutes(app: FastifyInstance) {
  const uc=new NfeDevolucaoUseCase();
  app.get("/nfe/devolucao/disponibilidade",{preHandler:[authMiddleware]},async(req,reply)=>{
    const user=(req as FastifyRequest & {user:{dataOwnerId:string}}).user;
    const companies=await new CompanyFiscalRepository().findByUserId(user.dataOwnerId);
    return companies && isDevolucaoAtiva(companies.id)?reply.send({disponivel:true,companyFiscalConfigId:companies.id}):reply.code(404).send({error:"Recurso indisponível"});
  });
  const handle=(action:(u:string,a:string,id:string,b:unknown,reply:FastifyReply)=>Promise<unknown>)=>async(req:FastifyRequest,reply:FastifyReply)=>{
    const user=(req as FastifyRequest & {user:{id:string;dataOwnerId:string}}).user;
    try{return await action(user.dataOwnerId,user.id,(req.params as {id?:string}).id??"",req.body,reply);}
    catch(e){
      if(e instanceof DevolucaoError)return reply.code(e.httpStatus).send({error:e.message,code:e.code,issues:e.issues});
      if(e instanceof NumeracaoError)return reply.code(e.httpStatus).send({error:e.message,...(e.httpStatus===404?{}:{code:e.code})});
      if(tabelaFiscalAusente(e))return reply.code(404).send({error:"Recurso indisponível"});
      return reply.code(500).send({error:"Não foi possível concluir a operação de devolução"});
    }
  };
  const invalid=(reply:FastifyReply,erros:Parameters<typeof respostaErroDevolucao>[1])=>{const r=respostaErroDevolucao("PAYLOAD_INVALIDO",erros);return reply.code(r.status).send(r.body);};
  app.post("/nfe/:id/devolucao",{preHandler:[authMiddleware]},handle(async(u,a,id,b,r)=>{const p=parseCriarDevolucaoBody(b);if(!p.ok)return invalid(r,{erros:p.erros});const result=await uc.criar(u,a,id,p.value);return r.code(result.reutilizado?200:201).send(result);}));
  app.get("/nfe/:id/devolucao/saldo",{preHandler:[authMiddleware]},handle(async(u,_a,id)=>uc.saldo(u,id)));
  app.get("/nfe/draft/:id/devolucao",{preHandler:[authMiddleware]},handle(async(u,_a,id)=>uc.detalhe(u,id)));
  app.put("/nfe/draft/:id/devolucao",{preHandler:[authMiddleware]},handle(async(u,a,id,b,r)=>{const p=parseAtualizarCabecalhoBody(b);return p.ok?uc.cabecalho(u,a,id,p.value):invalid(r,{erros:p.erros});}));
  app.put("/nfe/draft/:id/devolucao/itens",{preHandler:[authMiddleware]},handle(async(u,a,id,b,r)=>{const p=parseAtualizarItensBody(b);return p.ok?uc.itens(u,a,id,p.value):invalid(r,{erros:p.erros});}));
  app.post("/nfe/devolucao/manual",{preHandler:[authMiddleware],bodyLimit:1_200_000},handle(async(u,a,_id,b,r)=>{const p=parseManualBody(b);return p.ok?r.code(201).send(await uc.manual(u,a,p.value)):invalid(r,{erros:p.erros});}));
}

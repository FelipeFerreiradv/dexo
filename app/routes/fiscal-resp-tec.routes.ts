import type { FastifyInstance, FastifyRequest } from "fastify";
import { authMiddleware } from "../middlewares/auth.middleware";
import { CompanyFiscalRespTecUseCase } from "../usecases/company-fiscal-resp-tec.usecase";
import { NumeracaoError, tabelaFiscalAusente } from "../fiscal/numeracao/numeracao.errors";

export async function fiscalRespTecRoutes(fastify: FastifyInstance) {
  const usecase = new CompanyFiscalRespTecUseCase();
  for (const url of ["/config/resp-tec", "/companies/:id/resp-tec"]) {
    for (const method of ["GET", "PUT"] as const) {
      fastify.route({ method,url,preHandler:[authMiddleware],handler:async (request: FastifyRequest,reply) => {
        const auth = (request as FastifyRequest & {user:{id:string;dataOwnerId:string}}).user;
        const id = (request.params as {id?:string}).id;
        try {
          const respTec = method === "GET" ? await usecase.get(auth.dataOwnerId,id) : await usecase.put(auth.dataOwnerId,auth.id,request.body,id);
          return reply.send({respTec});
        } catch (error) {
          if (error instanceof NumeracaoError) return reply.status(error.httpStatus).send({error:error.message,code:error.code,detalhes:error.detalhes});
          if (tabelaFiscalAusente(error)) return reply.status(404).send({error:"Recurso indisponível"});
          // Do not serialize database/crypto exceptions (they can contain bind parameters).
          return reply.status(500).send({error:"Não foi possível salvar ou consultar o responsável técnico"});
        }
      }});
    }
  }
}

import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/prisma";
import type { RespTecRow } from "../fiscal/providers/nfe-provider-resolver";
import { NumeracaoError } from "../fiscal/numeracao/numeracao.errors";

export interface ICompanyFiscalRespTecRepository {
  find(userId: string, configId: string): Promise<RespTecRow | null>;
  update(userId: string, configId: string, actorUserId: string, build: (existing: RespTecRow | null) => RespTecRow): Promise<RespTecRow>;
}
export class CompanyFiscalRespTecRepository implements ICompanyFiscalRespTecRepository {
  constructor(private readonly db: PrismaClient = prisma) {}
  async find(userId: string, configId: string): Promise<RespTecRow | null> {
    const rows = await this.db.$queryRawUnsafe<RespTecRow[]>(`SELECT r."modo",r."cnpj",r."xContato",r."email",r."fone",r."idCsrt",r."csrtEnc"
      FROM "CompanyFiscalRespTec" r JOIN "CompanyFiscalConfig" c ON c."id"=r."companyFiscalConfigId"
      WHERE r."userId"=$1 AND c."userId"=$1 AND r."companyFiscalConfigId"=$2`, userId, configId);
    return rows[0] ?? null;
  }
  update(userId: string, configId: string, actorUserId: string, build: (existing: RespTecRow | null) => RespTecRow): Promise<RespTecRow> {
    return this.db.$transaction(async tx => {
      const config = await tx.$queryRawUnsafe<{id: string}[]>(`SELECT "id" FROM "CompanyFiscalConfig" WHERE "id"=$1 AND "userId"=$2 FOR UPDATE`, configId, userId);
      if (!config.length) throw new NumeracaoError("EMPRESA_NAO_ENCONTRADA", 404, "Empresa não encontrada");
      const rows = await tx.$queryRawUnsafe<RespTecRow[]>(`SELECT * FROM "CompanyFiscalRespTec" WHERE "companyFiscalConfigId"=$1 AND "userId"=$2 FOR UPDATE`, configId, userId);
      const r = build(rows[0] ?? null);
      await tx.$executeRawUnsafe(`INSERT INTO "CompanyFiscalRespTec"
        ("id","companyFiscalConfigId","userId","modo","cnpj","xContato","email","fone","idCsrt","csrtEnc","updatedByUserId")
        VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT ("companyFiscalConfigId") DO UPDATE SET "modo"=EXCLUDED."modo","cnpj"=EXCLUDED."cnpj",
        "xContato"=EXCLUDED."xContato","email"=EXCLUDED."email","fone"=EXCLUDED."fone","idCsrt"=EXCLUDED."idCsrt",
        "csrtEnc"=EXCLUDED."csrtEnc","updatedByUserId"=EXCLUDED."updatedByUserId","updatedAt"=NOW()
        WHERE "CompanyFiscalRespTec"."userId"=EXCLUDED."userId"`, configId,userId,r.modo,r.cnpj,r.xContato,r.email,r.fone,r.idCsrt,r.csrtEnc,actorUserId);
      return r;
    });
  }
}

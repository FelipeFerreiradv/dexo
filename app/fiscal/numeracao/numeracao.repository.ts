import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../lib/prisma";
import { cnpjNaChave } from "./decisao";
import type { ChaveFiscal, EventoTrilha } from "./decisao";
import { assertTransicao } from "./estados";
import { concorrencia, NumeracaoError } from "./numeracao.errors";
import type { ContextoReserva, INfeNumeracaoRepository, NotaPatch, NovaReserva, NovaTentativa, NumeracaoTx, Ocupacao, Reserva, ReservaPatch, Sequencia, Tentativa, TentativaPatch } from "./persistencia";
import type { EstadoReserva } from "./tipos";
export type { INfeNumeracaoRepository } from "./persistencia";

type SqlClient = Pick<Prisma.TransactionClient, "$queryRawUnsafe"|"$executeRawUnsafe">;
const RESERVA_COLUNAS = ["motivo", "requerInutilizacao", "bloqueadoAte", "leaseAte", "consumidoEm", "provedorUltimo", "ultimaClasse", "ultimoCStat", "ultimoCodigoProvedor"];
const TENTATIVA_COLUNAS = ["fase", "httpStatus", "transporte", "cStat", "codigoProvedor", "classe", "prova", "mensagem", "protocolo", "numeroLido", "serieLida", "nRec", "respondidaEm", "consultadaEm"];
const NOTA_COLUNAS = ["status", "motivoRejeicao", "cStatRejeicao", "chaveAcesso", "protocoloAutorizacao", "dataAutorizacao", "dataEmissao", "xmlAssinadoPath", "numero", "serie"];

/**
 * CNPJ do emitente desta chave fiscal, como a chave de acesso o grava (só
 * dígitos; CPF vira `000`+CPF). Preferência ao campo explícito; sem ele, o
 * snapshot do emitente que a própria reserva já persiste em `emitenteJson`.
 * `null` ⇒ não dá para afirmar de quem é a nota, e o piso não filtra.
 */
function cnpjDoContexto(c: ContextoReserva): string | null {
  const snapshot = c.emitenteSnapshot as { cnpj?: unknown } | null | undefined;
  return cnpjNaChave(c.cnpjEmitente) ?? cnpjNaChave(snapshot?.cnpj);
}

/** Identificadores vêm exclusivamente destas allowlists; valores sempre são parâmetros. */
function setters(patch: object, allowed: readonly string[], values: unknown[]): string[] {
  return Object.entries(patch).filter(([key, value]) => allowed.includes(key) && value !== undefined).map(([key, value]) => {
    values.push(value);
    return `"${key}"=$${values.length}`;
  });
}

class SqlNumeracaoTx implements NumeracaoTx {
  constructor(protected readonly db: SqlClient) {}
  get sql(): SqlClient { return this.db; }
  private async rows<T>(sql: string, values: unknown[]): Promise<T[]> {
    return this.db.$queryRawUnsafe<T[]>(sql, ...values);
  }

  async lockSequencia(userId: string, k: ChaveFiscal, isDefault: boolean): Promise<Sequencia> {
    const values = [userId, k.ambiente, k.serie, k.modelo, k.cfc, isDefault];
    const sql = `SELECT "id","proximoNumero" FROM "NfeSequence"
      WHERE "userId"=$1 AND "ambiente"=$2 AND "serie"=$3 AND "modelo"=$4
      AND ("companyFiscalConfigId"=$5 OR ($6 AND "companyFiscalConfigId" IS NULL))
      ORDER BY ("companyFiscalConfigId" IS NULL) ASC LIMIT 1 FOR UPDATE`;
    const existing = await this.rows<Sequencia>(sql, values);
    if (existing[0]) return existing[0];
    await this.rows(`INSERT INTO "NfeSequence" ("id","userId","ambiente","serie","modelo","proximoNumero","companyFiscalConfigId","updatedAt")
      VALUES (gen_random_uuid()::text,$1,$2,$3,$4,1,$5,NOW()) ON CONFLICT DO NOTHING`, values.slice(0, 5));
    const retry = await this.rows<Sequencia>(sql, values);
    if (!retry[0]) throw new NumeracaoError("NUMERACAO_INCONSISTENTE", 409, "Não foi possível reservar número para o emitente — contate o suporte");
    return retry[0];
  }

  async avancarContador(id: string, cfc: string, proximo: number): Promise<number> {
    const rows = await this.rows<{proximoNumero: number}>(`UPDATE "NfeSequence" SET "proximoNumero"=GREATEST("proximoNumero",$3),
      "companyFiscalConfigId"=$2,"updatedAt"=NOW() WHERE "id"=$1 RETURNING "proximoNumero"`, [id, cfc, proximo]);
    if (!rows[0]) concorrencia();
    return rows[0].proximoNumero;
  }

  reservas(userId: string, nfeId: string, lock = false): Promise<Reserva[]> {
    return this.rows(`SELECT * FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "nfeId"=$2 ORDER BY "createdAt" DESC,"id"${lock ? " FOR UPDATE" : ""}`, [userId, nfeId]);
  }
  async reserva(userId: string, id: string, lock = false): Promise<Reserva | null> {
    return (await this.rows<Reserva>(`SELECT * FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "id"=$2${lock ? " FOR UPDATE" : ""}`, [userId, id]))[0] ?? null;
  }
  reservasNaChave(userId: string, k: ChaveFiscal, lock = false): Promise<Reserva[]> {
    return this.rows(`SELECT * FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "companyFiscalConfigId"=$2 AND "ambiente"=$3 AND "modelo"=$4 AND "serie"=$5 ORDER BY "createdAt" DESC,"numero" DESC${lock ? " FOR UPDATE" : ""}`, [userId, k.cfc, k.ambiente, k.modelo, k.serie]);
  }
  async inserirReserva(r: NovaReserva): Promise<Reserva> {
    const rows = await this.rows<Reserva>(`INSERT INTO "NfeNumeroReserva"
      ("userId","companyFiscalConfigId","ambiente","modelo","serie","numero","nfeId","estado","origem","cNF","ultimoCStat")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [r.userId, r.companyFiscalConfigId, r.ambiente, r.modelo, r.serie, r.numero, r.nfeId, r.estado, r.origem, r.cNF, r.ultimoCStat ?? null]);
    return rows[0];
  }
  async transicionar(r: Reserva, estado: EstadoReserva, patch: ReservaPatch = {}): Promise<Reserva> {
    assertTransicao(r.estado, estado);
    return this.patchReserva(r, patch, estado);
  }
  atualizarReserva(r: Reserva, patch: ReservaPatch): Promise<Reserva> { return this.patchReserva(r, patch); }
  private async patchReserva(r: Reserva, patch: ReservaPatch, estado?: EstadoReserva): Promise<Reserva> {
    const values: unknown[] = [r.id, r.userId, r.estado, r.updatedAt];
    const sets = setters(patch, RESERVA_COLUNAS, values);
    if (estado) { values.push(estado); sets.push(`"estado"=$${values.length}`); }
    // Monotonic version timestamp also fences lease ownership within the same millisecond.
    sets.push(`"updatedAt"=GREATEST(NOW(),"updatedAt" + interval '1 millisecond')`);
    const rows = await this.rows<Reserva>(`UPDATE "NfeNumeroReserva" SET ${sets.join(",")}
      WHERE "id"=$1 AND "userId"=$2 AND "estado"=$3 AND "updatedAt"=$4 RETURNING *`, values);
    if (!rows[0]) concorrencia();
    return rows[0];
  }

  async ocupacao(c: ContextoReserva, numero: number): Promise<Ocupacao> {
    // NÃO filtrar por CNPJ da chave aqui (ver `pisoPorEvidencia`): a pergunta é outra.
    // O piso pergunta "até onde a SEFAZ já numerou ESTA empresa"; a ocupação pergunta
    // "esta linha já existe na minha base". Nota importada de outro CNPJ ainda ocupa a
    // tupla do índice único (cfc, ambiente, série, número, modelo) — ignorá-la faria o
    // `gravarNumero` estourar unicidade e travar a emissão. Drafts nem têm chave.
    const k = c.key;
    const result = await this.rows<Ocupacao>(`SELECT
      EXISTS(SELECT 1 FROM "NfeEmitida" WHERE "userId"=$1 AND "ambiente"=$3 AND "modelo"=$4 AND "serie"=$5 AND "numero"=$6 AND "id"<>$7
        AND ("companyFiscalConfigId"=$2 OR ($8 AND "companyFiscalConfigId" IS NULL))) AS "emNota",
      EXISTS(SELECT 1 FROM "NfeInutilizacao" WHERE "userId"=$1 AND $4='55' AND "ambiente"=$3 AND "serie"=$5
        AND $6 BETWEEN "numeroInicial" AND "numeroFinal" AND ("status"='ACEITA' OR ("status"='PENDENTE' AND "createdAt">NOW()-interval '15 minutes'))
        AND ("companyFiscalConfigId"=$2 OR ($8 AND "companyFiscalConfigId" IS NULL))) AS "inutilizado",
      EXISTS(SELECT 1 FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "companyFiscalConfigId"=$2 AND "ambiente"=$3 AND "modelo"=$4 AND "serie"=$5 AND "numero"=$6) AS "reservado"`,
    [c.userId, k.cfc, k.ambiente, k.modelo, k.serie, numero, c.nfeId, c.isDefault]);
    return result[0];
  }
  async pisoPorEvidencia(c: ContextoReserva): Promise<number> {
    // Uses the authorized access key, never MAX(numero)+1 over draft numbers.
    const k = c.key;
    // Chave de acesso (44): cUF 1-2, AAMM 3-6, CNPJ 7-20, mod 21-22, série 23-25, nNF 26-34.
    //
    // (a) EVIDÊNCIA: o nNF só conta quando o CNPJ da chave (7-20) é o do próprio
    //     emitente. Debaixo de uma config convivem notas históricas IMPORTADAS de
    //     empresas anteriores do mesmo dono, e a numeração delas não é a desta.
    //     Sem CNPJ conhecido ($7 NULL) esta metade fica exatamente como sempre foi.
    // (b) OCUPAÇÃO: número que ESTA base já materializou como documento emitido
    //     nesta série entra no piso mesmo sendo de terceiro — não como evidência da
    //     SEFAZ, mas porque o índice único (cfc, ambiente, série, número, modelo)
    //     torna impossível escolhê-lo. Sem esta metade, tirar a numeração do
    //     terceiro do piso jogaria o contador lá atrás e o laço de escolha teria de
    //     pular esses números um a um — e ele desiste em 50 (COLISOES_EXCESSIVAS),
    //     trocando "número errado, nota sai" por "nota travada". Só documento
    //     emitido: rascunho continua fora (o piso nunca foi MAX(numero)+1).
    const rows = await this.rows<{piso: number}>(`WITH chaves AS (
      SELECT regexp_replace(COALESCE("chaveAcesso",''),'[^0-9]','','g') AS chave FROM "NfeEmitida"
      WHERE "userId"=$1 AND "ambiente"=$3 AND "status" IN ('AUTHORIZED','CANCELLED','SENDING')
      AND ("companyFiscalConfigId"=$2 OR ($6 AND "companyFiscalConfigId" IS NULL))
    ), numeros AS (
      SELECT substring(chave,26,9)::integer AS numero FROM chaves
      WHERE length(chave)=44 AND substring(chave,21,2)=$4 AND substring(chave,23,3)::integer=$5
      AND ($7::text IS NULL OR substring(chave,7,14)=$7::text)
      UNION ALL SELECT "numero" FROM "NfeEmitida" WHERE "userId"=$1 AND "ambiente"=$3 AND "modelo"=$4 AND "serie"=$5
      AND "numero">0 AND "status" IN ('AUTHORIZED','CANCELLED','SENDING')
      AND ("companyFiscalConfigId"=$2 OR ($6 AND "companyFiscalConfigId" IS NULL))
      UNION ALL SELECT "numeroFinal" FROM "NfeInutilizacao" WHERE "userId"=$1 AND "ambiente"=$3 AND "serie"=$5
      AND $4='55' AND "status"='ACEITA' AND ("companyFiscalConfigId"=$2 OR ($6 AND "companyFiscalConfigId" IS NULL))
    ) SELECT COALESCE(MAX(numero),0)::integer AS piso FROM numeros`, [c.userId, k.cfc, k.ambiente, k.modelo, k.serie, c.isDefault, cnpjDoContexto(c)]);
    return rows[0].piso;
  }
  trilha(userId: string, nfeId: string): Promise<EventoTrilha[]> {
    return this.rows(`SELECT "evento","detalhes","createdAt" FROM "NfeAuditLog" WHERE "userId"=$1 AND "nfeId"=$2 ORDER BY "createdAt","id"`, [userId, nfeId]);
  }
  async gravarNumero(c: ContextoReserva, numero: number): Promise<void> {
    const k = c.key;
    const rows = await this.rows(`UPDATE "NfeEmitida" SET "numero"=$3,"ambiente"=$4,"companyFiscalConfigId"=$5,
      "emitenteJson"=$6::jsonb,"chaveAcesso"=NULL,"dataEmissao"=NOW(),"updatedAt"=COALESCE($7::timestamp,NOW())
      WHERE "id"=$1 AND "userId"=$2 AND "status"='VALIDATING' AND ($7::timestamp IS NULL OR "updatedAt"=$7) RETURNING "id"`, [c.nfeId, c.userId, numero, k.ambiente, k.cfc, JSON.stringify(c.emitenteSnapshot),c.claimEm??null]);
    if (rows.length !== 1) concorrencia();
    if(c.calculo) {
      await this.db.$executeRawUnsafe('UPDATE "NfeEmitida" SET "totaisJson"=$3::jsonb WHERE "id"=$1 AND "userId"=$2',c.nfeId,c.userId,JSON.stringify(c.calculo.totaisJson));
      for(const item of c.calculo.itens)await this.db.$executeRawUnsafe('UPDATE "NfeItem" SET "tributosJson"=$3::jsonb WHERE "nfeId"=$1 AND "numero"=$2',c.nfeId,item.numero,JSON.stringify(item.tributosJson));
    }
  }
  tentativas(userId: string, reservaId: string, lock = false): Promise<Tentativa[]> {
    return this.rows(`SELECT * FROM "NfeNumeroTentativa" WHERE "userId"=$1 AND "reservaId"=$2 ORDER BY "seq" DESC${lock ? " FOR UPDATE" : ""}`, [userId, reservaId]);
  }
  async inserirTentativa(t: NovaTentativa): Promise<Tentativa> {
    const rows = await this.rows<Tentativa>(`INSERT INTO "NfeNumeroTentativa"
      ("reservaId","nfeId","userId","seq","provedor","ambiente","chaveAcesso","cNF","dhEmi","digestValue","xmlAssinadoPath","conteudoSha256","focusRef","transmitidaEm","fase")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'TRANSMITINDO') RETURNING *`,
    [t.reservaId, t.nfeId, t.userId, t.seq, t.provedor, t.ambiente, t.chaveAcesso, t.cNF, t.dhEmi, t.digestValue, t.xmlAssinadoPath, t.conteudoSha256, t.focusRef, t.transmitidaEm]);
    return rows[0];
  }
  async atualizarTentativa(t: Tentativa, patch: TentativaPatch): Promise<Tentativa> {
    const values: unknown[] = [t.id, t.userId, t.fase];
    const sets = setters(patch, TENTATIVA_COLUNAS, values);
    if (!sets.length) return t;
    const rows = await this.rows<Tentativa>(`UPDATE "NfeNumeroTentativa" SET ${sets.join(",")} WHERE "id"=$1 AND "userId"=$2 AND "fase"=$3 RETURNING *`, values);
    if (!rows[0]) concorrencia();
    return rows[0];
  }
  async atualizarNota(userId: string, nfeId: string, estados: string[], patch: NotaPatch): Promise<void> {
    const values: unknown[] = [userId, nfeId, estados];
    const sets = setters(patch, NOTA_COLUNAS, values);
    sets.push('"updatedAt"=NOW()');
    const rows = await this.rows(`UPDATE "NfeEmitida" SET ${sets.join(",")} WHERE "userId"=$1 AND "id"=$2 AND "status"=ANY($3::text[]) RETURNING "id"`, values);
    if (rows.length !== 1) concorrencia();
  }
  async excluirRascunho(userId: string, nfeId: string): Promise<void> {
    const rows = await this.rows(`DELETE FROM "NfeEmitida" WHERE "userId"=$1 AND "id"=$2 AND "status" IN ('DRAFT','REJECTED') RETURNING "id"`, [userId, nfeId]);
    if (rows.length !== 1) throw new NumeracaoError("RASCUNHO_NAO_ENCONTRADO", 404, "Rascunho de NF-e não encontrado");
  }
  linhasNaFaixa(userId: string, k: ChaveFiscal, isDefault: boolean, ini: number, fim: number): Promise<Array<{id: string; numero: number; status: string}>> {
    return this.rows(`SELECT "id","numero","status" FROM "NfeEmitida" WHERE "userId"=$1 AND "ambiente"=$3 AND "modelo"=$4 AND "serie"=$5
      AND ("companyFiscalConfigId"=$2 OR ($6 AND "companyFiscalConfigId" IS NULL)) AND "numero" BETWEEN $7 AND $8 ORDER BY "numero"`, [userId, k.cfc, k.ambiente, k.modelo, k.serie, isDefault, ini, fim]);
  }
}

export class NfeNumeracaoRepository extends SqlNumeracaoTx implements INfeNumeracaoRepository {
  constructor(private readonly client: PrismaClient = prisma) { super(client); }
  transaction<T>(fn: (tx: NumeracaoTx) => Promise<T>): Promise<T> {
    return this.client.$transaction(tx => fn(new SqlNumeracaoTx(tx)), { maxWait: 5000, timeout: 15000 });
  }
}

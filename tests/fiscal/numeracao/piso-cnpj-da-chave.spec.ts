// Correção 3: o piso por evidência não conferia o CNPJ embutido na chave.
//
// `pisoPorEvidencia` deduz até onde a SEFAZ já numerou uma série lendo o nNF da
// chave de acesso (posições 26-34), filtrando por modelo (21-22) e série (23-25)
// — e nunca olhava o CNPJ (7-20). Debaixo de UMA config convivem notas
// históricas importadas de empresas anteriores do mesmo dono (VN Motors: 3.155
// chaves de 58388093000153 na série 3 e 396 de 35502529000198 na série 2, sob a
// config do 65416054000188), e o piso saía da numeração dessas outras empresas.
//
// Hoje isso é inofensivo porque `avancarContador` usa GREATEST — só levanta — e
// os contadores já estão à frente. Mas o piso é quem DEFINE o número numa série
// sem reservas prévias (numeracao.service.ts: `if (!anteriores.length)`), e é
// exatamente a série nova / config recriada / contador reiniciado que passaria a
// numerar a partir do documento de um terceiro.
//
// O que este arquivo prova (sem banco): a metade TypeScript — de onde sai o CNPJ
// que vai para a consulta, como ele é normalizado, e que sem CNPJ conhecido o
// parâmetro é NULL (o piso segue idêntico ao de antes, para todo chamador que
// não informa emitente). A semântica do SQL — "chave de outro CNPJ deixa de
// contar" — é provada contra PostgreSQL real em `piso-cnpj-postgres.spec.ts`.

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { cnpjNaChave, partesDaChave } from "../../../app/fiscal/numeracao/decisao";
import { chaveToString, montarChave } from "../../../app/fiscal/sefaz/chave-acesso";
import { NfeNumeracaoRepository } from "../../../app/fiscal/numeracao/numeracao.repository";
import type { ContextoReserva } from "../../../app/fiscal/numeracao/persistencia";

/** VN Motors — a config sob a qual as notas de terceiros foram importadas. */
const CNPJ_CONFIG = "65.416.054/0001-88";
const CNPJ_CONFIG_DIGITOS = "65416054000188";
/** Empresa anterior do mesmo dono: dona das 3.155 chaves da série 3. */
const CNPJ_OUTRO = "58388093000153";

/** O índice do parâmetro do CNPJ na consulta do piso (1-based $7 ⇒ 0-based 6). */
const IDX_CNPJ = 6;

function espiao() {
  const chamadas: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      chamadas.push({ sql, values });
      return [{ piso: 0 }];
    },
    $executeRawUnsafe: async () => 0,
  };
  return { chamadas, repo: new NfeNumeracaoRepository(client as unknown as PrismaClient) };
}

const contexto = (patch: Partial<ContextoReserva> = {}): ContextoReserva => ({
  userId: "tenant-vn",
  nfeId: "nfe-1",
  isDefault: false,
  key: { cfc: "cfg-vn", ambiente: "PRODUCAO", modelo: "55", serie: 3 },
  providerName: "SEFAZ_DIRECT",
  emitenteSnapshot: {},
  row: { numero: -1, serie: 3, ambiente: "PRODUCAO", companyFiscalConfigId: "cfg-vn", status: "DRAFT" },
  ...patch,
});

async function cnpjEnviado(c: ContextoReserva): Promise<unknown> {
  const { repo, chamadas } = espiao();
  await repo.pisoPorEvidencia(c);
  expect(chamadas).toHaveLength(1);
  return chamadas[0].values[IDX_CNPJ];
}

describe("cnpjNaChave — o CNPJ na forma em que a chave de acesso o grava", () => {
  it("tira a máscara do CNPJ da config", () => {
    expect(cnpjNaChave(CNPJ_CONFIG)).toBe(CNPJ_CONFIG_DIGITOS);
    expect(cnpjNaChave(CNPJ_CONFIG_DIGITOS)).toBe(CNPJ_CONFIG_DIGITOS);
  });

  it("emitente pessoa física: a chave usa 000 + CPF", () => {
    // Sem isso o emitente CPF ficaria com CNPJ "ilegível" e perderia o filtro —
    // mesma regra que `decidirReadbackFocus` já aplicava (chave 7-20 tem 14 dígitos).
    expect(cnpjNaChave("123.456.789-09")).toBe("00012345678909");
  });

  it("qualquer coisa que não seja um CNPJ de 14 dígitos vira null", () => {
    for (const ruim of ["", "   ", "654160540001", "654160540001889", "sem numero", null, undefined, 65416054000188, {}]) {
      expect(cnpjNaChave(ruim)).toBeNull();
    }
  });
});

describe("pisoPorEvidencia — de onde sai o CNPJ conferido", () => {
  it("usa o CNPJ da config do emitente, só dígitos", async () => {
    expect(await cnpjEnviado(contexto({ cnpjEmitente: CNPJ_CONFIG }))).toBe(CNPJ_CONFIG_DIGITOS);
  });

  it("sem o campo explícito, cai no snapshot do emitente que a reserva já persiste", async () => {
    expect(await cnpjEnviado(contexto({ emitenteSnapshot: { cnpj: CNPJ_OUTRO } }))).toBe(CNPJ_OUTRO);
  });

  it("o campo explícito vence o snapshot", async () => {
    expect(await cnpjEnviado(contexto({ cnpjEmitente: CNPJ_CONFIG, emitenteSnapshot: { cnpj: CNPJ_OUTRO } }))).toBe(CNPJ_CONFIG_DIGITOS);
  });

  it("sem CNPJ legível em lugar nenhum, manda NULL — o piso fica como sempre foi", async () => {
    // Zero regressão: todo chamador que não informa emitente (specs antigos,
    // harness em memória) continua vendo exatamente a consulta de antes.
    expect(await cnpjEnviado(contexto())).toBeNull();
    expect(await cnpjEnviado(contexto({ cnpjEmitente: null, emitenteSnapshot: null }))).toBeNull();
    expect(await cnpjEnviado(contexto({ cnpjEmitente: "", emitenteSnapshot: "config" }))).toBeNull();
  });

  it("os 6 parâmetros anteriores seguem na mesma posição", async () => {
    const { repo, chamadas } = espiao();
    await repo.pisoPorEvidencia(contexto({ cnpjEmitente: CNPJ_CONFIG }));
    expect(chamadas[0].values).toEqual(["tenant-vn", "cfg-vn", "PRODUCAO", "55", 3, false, CNPJ_CONFIG_DIGITOS]);
  });

  it("guarda estrutural: o parâmetro é comparado com o recorte 7-14 da chave", async () => {
    // Fraca de propósito — só impede que alguém remova o predicado e deixe o
    // parâmetro órfão. Quem prova a semântica é o spec de PostgreSQL.
    const { repo, chamadas } = espiao();
    await repo.pisoPorEvidencia(contexto({ cnpjEmitente: CNPJ_CONFIG }));
    const sql = chamadas[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("substring(chave,7,14)=$7");
    // E a metade (b): número que esta base já ocupa nesta série segue no piso,
    // senão o laço de escolha teria de pular os do terceiro um a um (teto de 50).
    expect(sql).toContain(`SELECT "numero" FROM "NfeEmitida"`);
    expect(sql).toContain(`"numero">0`);
  });
});

describe("o recorte 7-14 é mesmo o CNPJ (aritmética 1-based do PostgreSQL)", () => {
  // O erro mais provável numa mudança em SQL cru é o off-by-one: `substring` do
  // PostgreSQL é 1-based e o `slice` do JS é 0-based. Aqui a chave é montada pelo
  // gerador canônico (DV módulo 11 conferido) e lida pelo leitor canônico, e cada
  // recorte da consulta é confrontado com a parte que ele deveria pegar.
  const chave = chaveToString(montarChave({
    uf: "PR", ano: 2026, mes: 9, cnpj: CNPJ_OUTRO, modelo: "55", serie: 3, numero: 4052, tpEmis: 1, cNF: "87654321",
  }));

  it("cada substring da consulta cai sobre o campo certo", () => {
    const partes = partesDaChave(chave);
    expect(partes).not.toBeNull();
    expect(chave).toHaveLength(44);
    expect(chave.slice(6, 20)).toBe(partes!.CNPJ); // substring(chave,7,14)
    expect(chave.slice(20, 22)).toBe(partes!.mod); // substring(chave,21,2)
    expect(chave.slice(22, 25)).toBe(partes!.serie); // substring(chave,23,3)
    expect(chave.slice(25, 34)).toBe(partes!.nNF); // substring(chave,26,9)
  });

  it("e o CNPJ recortado é o da empresa que emitiu, não o da config", () => {
    expect(chave.slice(6, 20)).toBe(CNPJ_OUTRO);
    expect(chave.slice(6, 20)).not.toBe(CNPJ_CONFIG_DIGITOS);
    expect(Number(chave.slice(25, 34))).toBe(4052);
  });
});

import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    location: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    product: { findMany: vi.fn(async () => []) },
    customer: { findMany: vi.fn(async () => []) },
    scrap: { findMany: vi.fn(async () => []) },
    receivable: { findMany: vi.fn(async () => []) },
    payable: { findMany: vi.fn(async () => []) },
    nfeEmitida: { findMany: vi.fn(async () => []) },
  },
}));

import {
  detectFile,
  detectAndValidate,
} from "../../app/usecases/import/import-detector";
import type {
  ImportContext,
  ImportFile,
} from "../../app/usecases/import/import.types";
import {
  mapIbrsoftClientes,
  mapIbrsoftLocalizacoes,
  mapIbrsoftSucatas,
  mapIbrsoftProdutos,
  mapIbrsoftNfes,
  mapIbrsoftContas,
} from "../../app/usecases/import/mappers/ibrsoft.mappers";
import {
  runIbrsoftPacote,
  type IbrsoftPacoteDeps,
} from "../../app/usecases/import/executors/ibrsoft-pacote.executor";
import type { ProductCreate } from "../../app/interfaces/product.interface";

/* --------- cabeçalhos REAIS do export IBR Soft (CSV ";" — ordem fiel) ------- */

const H = {
  produtos:
    "codigo;codigo_fabricante;criado_em;descricao;unidade;estoque;custo_compra;valor_venda;marca;modelo;lote;ano_sucata;localizacao;sigla_localizacao;placa;ncm;cest;peso;comprimento;largura;altura;observacao;possui_foto;publicado_mercado_livre",
  sucatas:
    "id;codigo_sequencial;codigo;ativa;status;fornecedor;documento_fornecedor;chave_acesso_nfe;numero_nfe;serie_nfe;data_entrada;certidao_baixa;lote;marca;modelo;versao;ano;cor;placa;chassi;renavam;numero_motor;ncm;valor_compra;total_desmembrado;localizacao;sigla_localizacao;informacoes_adicionais;criado_em;atualizado_em",
  localizacoes:
    "id;sigla;descricao;caminho_siglas;caminho_descricao;caminho_hierarquia;id_pai;nivel;aceita_estoque;altura_cm;largura_cm;profundidade_cm;volume_m3;quantidade_maxima;criado_em;atualizado_em",
  costumers:
    "id;ativo;tipo;nome_razao_social;nome_fantasia;cpf_cnpj;rg_ie;telefone;celular;email;nascimento;cep;logradouro;numero;complemento;bairro;cidade;uf;ibge;nome_entrega;documento_entrega;telefone_entrega;cep_entrega;logradouro_entrega;numero_entrega;complemento_entrega;bairro_entrega;cidade_entrega;uf_entrega;limite_credito;permite_venda_prazo;observacoes;criado_em;atualizado_em",
  nfe: "id;numero_nota;serie;chave_acesso;protocolo;destinatario;tipo;status;valor;natureza_operacao;cliente;documento_cliente;fornecedor;documento_fornecedor;id_venda;nota_sucata;criado_em;atualizado_em",
  pagar:
    "id;tipo;status;favorecido;documento_favorecido;documento_conta;observacao;parcela;total_parcelas;valor_inicial;valor_atual;valor_pago;percentual_juros;percentual_multa;vencimento;ultimo_pagamento;id_compra;id_venda;removida;estornada;criado_em;atualizado_em",
  receber:
    "id;tipo;status;cliente;documento_cliente;documento_conta;observacao;parcela;total_parcelas;valor_inicial;valor_atual;valor_recebido;percentual_juros;percentual_multa;vencimento;ultimo_recebimento;id_venda;removida;estornada;criado_em;atualizado_em",
};

function file(header: string, lines: string[], filename = "arquivo.csv"): ImportFile {
  return {
    fieldname: "file",
    filename,
    buffer: Buffer.from([header, ...lines].join("\n"), "utf8"),
  };
}
const detected = (header: string, lines: string[]) => detectFile(file(header, lines));

/* ============================== DETECTOR ================================= */

describe("import/ibrsoft — detector por assinatura (CSV ';')", () => {
  const CASES: Array<[keyof typeof H, string, string]> = [
    ["produtos", "P100;;;Farol;UN;3;10;160;Ford;KA;;;;A > B;ABC1234;8708", "IBRSOFT_PRODUTOS"],
    ["sucatas", "g1;1;;t;Ativa;;;;;;2020-01-01;CB1;L1;VW;GOL;;2010;PRETO;ABC1234;9BWAG4124FT592152;;;8708;1000", "IBRSOFT_SUCATAS"],
    ["localizacoes", "g1;A;Barr;A > B;;;p1;2;t;;;;;5", "IBRSOFT_LOCALIZACOES"],
    ["costumers", "g1;t;Pessoa fisica;MARIA SILVA;;52998224725;;;;;", "IBRSOFT_CLIENTES"],
    ["nfe", "g1;10;1;35200114200166000187550010000000101000000019;;FULANO;Saida;Autorizada;100;VENDA", "IBRSOFT_NFE"],
    ["pagar", "g1;PAGAR;Parcial;FORNEC;123;D1;;1;1;500;0;500;;;2024-01-10;2024-01-10;;;f;f", "IBRSOFT_CONTAS_PAGAR"],
    ["receber", "g1;RECEBER;Aberta;CLIENTE;123;D1;;1;1;500;500;0;;;2024-01-10;;;f;f", "IBRSOFT_CONTAS_RECEBER"],
  ];
  for (const [key, row, kind] of CASES) {
    it(`${key}.csv → ${kind}`, () => {
      expect(detected(H[key], [row]).kind).toBe(kind);
    });
  }

  it("PACOTE: aceita todos os 7 e IGNORA (sem derrubar) um arquivo estranho", () => {
    const files: ImportFile[] = [
      file(H.produtos, ["P1;;;X;UN;1;1;10;;;;;;A;;"], "produtos.csv"),
      file(H.sucatas, ["g;1;;t;Ativa;;;;;;;;;VW;GOL;;;;;;;;;100", ], "sucatas.csv"),
      file(H.localizacoes, ["g;A;A;A;;;;;t;;;;;1"], "localizacoes.csv"),
      file(H.costumers, ["g;t;Pessoa fisica;JOAO;;52998224725;;;;;"], "costumers.csv"),
      file(H.nfe, ["g;1;1;35200114200166000187550010000000101000000019;;F;Saida;Autorizada;10;VENDA"], "nfe.csv"),
      file(H.pagar, ["g;PAGAR;Parcial;F;1;D;;1;1;10;0;10;;;2024-01-01;2024-01-01;;;f;f"], "contas_a_pagar.csv"),
      file(H.receber, ["g;RECEBER;Aberta;C;1;D;;1;1;10;10;0;;;2024-01-01;;;f;f"], "contas_a_receber.csv"),
      file("nome;valor;bla", ["x;1;y"], "planilha-aleatoria.csv"),
    ];
    const { files: accepted, ignored } = detectAndValidate("IBRSOFT", "PACOTE", files);
    expect(accepted).toHaveLength(7);
    expect(ignored).toHaveLength(1);
    expect(ignored[0].filename).toBe("planilha-aleatoria.csv");
  });

  it("PACOTE: subconjunto (só produtos) é válido — não exige todos", () => {
    const { files: accepted } = detectAndValidate("IBRSOFT", "PACOTE", [
      file(H.produtos, ["P1;;;X;UN;1;1;10;;;;;;A;;"], "produtos.csv"),
    ]);
    expect(accepted).toHaveLength(1);
  });
});

/* ============================== MAPPERS ================================== */

describe("import/ibrsoft — mappers", () => {
  it("clientes: PF/PJ, dedup por documento, descarta sem nome", () => {
    const r = mapIbrsoftClientes(
      detected(H.costumers, [
        "g1;t;Pessoa fisica;MARIA;;52998224725;RG1;;;maria@x.com;;;;;;;;SP",
        "g2;t;Pessoa juridica;ACME LTDA;ACME;11444777000161;IE1;;;;;;;;;;;RJ",
        "g3;t;Pessoa fisica;MARIA DUP;;52998224725;;;;;", // doc duplicado → dedup
        "g4;t;Pessoa fisica;;;;;;;;", // sem nome → descartado
      ]),
    );
    expect(r.items).toHaveLength(2);
    expect(r.skippedPlaceholder).toBe(1);
    expect(r.skippedDuplicateInSheet).toBe(1);
    const pf = r.items.find((c) => c.personType === "PF")!;
    const pj = r.items.find((c) => c.personType === "PJ")!;
    expect(pf.cpf).toBe("52998224725");
    expect(pf.cnpj).toBeNull();
    expect(pj.cnpj).toBe("11444777000161");
    expect(pj.nomeFantasia).toBe("ACME");
    expect(pf.notes).toContain("cliente #g1");
  });

  it("localizações: monta a árvore hierárquica (pais antes dos filhos)", () => {
    const r = mapIbrsoftLocalizacoes(
      detected(H.localizacoes, [
        "g1;A;Barr;BARR. > CX 1;;;;;t;;;;;5",
        "g2;B;Barr;BARR. > CX 2;;;;;t;;;;;3",
      ]),
    );
    const codes = r.items.map((l) => l.code);
    expect(codes).toContain("BARR.");
    expect(codes).toContain("BARR. > CX 1");
    expect(codes.indexOf("BARR.")).toBeLessThan(codes.indexOf("BARR. > CX 1"));
    const cx1 = r.items.find((l) => l.code === "BARR. > CX 1")!;
    expect(cx1.parentCode).toBe("BARR.");
    expect(cx1.maxCapacity).toBe(5);
  });

  it("sucatas: chave da sucata é codigo_sequencial; chassi inválido vira aviso (não derruba)", () => {
    const r = mapIbrsoftSucatas(
      detected(H.sucatas, [
        "g1;7;;t;Ativa;;;;;;;;LOTE9;VW;GOL;;2010;PRETO;ABC1234;9BWAG4124FT592152;;;8708;1500",
        "g2;8;;t;Ativa;;;;;;;;;FIAT;UNO;;2011;BRANCO;XYZ9A88;CHASSISUJO;;;;900",
      ]),
    );
    expect(r.items).toHaveLength(2);
    expect(r.items[0].cod).toBe("7");
    expect(r.items[0].plate).toBe("ABC1234");
    expect(r.items[0].chassis).toBe("9BWAG4124FT592152");
    expect(r.items[0].cost).toBe(1500);
    // chassi sujo → null + aviso, linha preservada.
    expect(r.items[1].chassis).toBeNull();
    expect(r.avisos.length).toBeGreaterThanOrEqual(1);
  });

  it("produtos: SKU=codigo, localização hierárquica, vínculo por placa/lote, ignora sem código", () => {
    const r = mapIbrsoftProdutos(
      detected(H.produtos, [
        "S100;789;;Farol;UN;3;12.5;160;Ford;KA;;;;BARR. > CX 1;ABC1234;8708",
        "S101;;;Lanterna;UN;1;0;90;Fiat;Uno;LOTE9;;;;;", // sem loc/placa, com nada
        ";;;Sem codigo;UN;9;0;50;;;;;;;;", // sem código → ignorado
        "S100;;;Dup;UN;2;0;10;;;;;;;;", // SKU duplicado no arquivo
      ]),
    );
    expect(r.produtos).toHaveLength(2);
    expect(r.semSku).toBe(1);
    expect(r.duplicadosSku).toBe(1);
    const p = r.produtos[0];
    expect(p.sku).toBe("S100");
    expect(p.price).toBe(160);
    expect(p.cost).toBe(12.5);
    expect(p.locationCode).toBe("BARR. > CX 1");
    expect(p.scrapPlate).toBe("ABC1234");
    // árvore de localização derivada dos caminhos dos produtos.
    expect(r.locationItems.map((l) => l.code)).toContain("BARR.");
  });

  it("nfe: colapsa série/número duplicado, mapeia status e tipo, extrai série da chave", () => {
    const chave = "35200114200166000187550120000001011000000019"; // série 012 → 12
    const r = mapIbrsoftNfes(
      detected(H.nfe, [
        `g1;101;;${chave};;FULANO;Saida;Autorizada;250.5;VENDA`,
        `g2;101;;${chave};;FULANO;Saida;Corrigida;250.5;VENDA`, // mesmo série/num → colapsa
        "g3;102;;;;SEM CHAVE;Entrada;Cancelada;30;DEVOLUCAO", // sem chave → aviso, série=1
      ]),
    );
    // 101 colapsado (2→1) + 102 = 2 itens.
    expect(r.items).toHaveLength(2);
    const n101 = r.items.find((n) => n.numero === 101)!;
    expect(n101.serie).toBe(12);
    expect(n101.status).toBe("AUTHORIZED");
    expect(n101.tipoOperacao).toBe("SAIDA");
    expect(n101.valor).toBe(250.5);
    const n102 = r.items.find((n) => n.numero === 102)!;
    expect(n102.status).toBe("CANCELLED");
    expect(n102.tipoOperacao).toBe("ENTRADA");
    expect(n102.chaveAcesso).toBeNull();
    expect(r.semChave).toBe(1);
  });

  it("contas: pula removida/estornada; quitada (pago≥inicial) vira PAGA", () => {
    const pagar = mapIbrsoftContas(
      detected(H.pagar, [
        "g1;PAGAR;Parcial;FORNEC;12345678909;D1;obs;1;1;500;0;500;;;2024-03-10;2024-03-12;;;f;f",
        "g2;PAGAR;Aberta;FORNEC2;;D2;;1;1;800;800;0;;;2024-04-01;;;;f;f",
        "g3;PAGAR;Removida;X;;D3;;1;1;100;0;0;;;2024-01-01;;;;t;f", // removida col + status
      ]),
      "payable",
    );
    expect(pagar.items).toHaveLength(2);
    const paga = pagar.items.find((c) => c.status === "PAGA")!;
    const pend = pagar.items.find((c) => c.status === "PENDENTE")!;
    expect(paga.totalAmount).toBe(500);
    expect(paga.paidAt).toBeInstanceOf(Date);
    expect(pend.totalAmount).toBe(800);
    expect(pagar.avisos.length).toBe(1); // a removida
    // markers distintos p/ idempotência.
    expect(paga.markerHash).not.toBe(pend.markerHash);
  });
});

/* ============================== EXECUTOR ================================= */

interface ExistingP {
  id: string;
  sku: string;
  skuNormalized: string | null;
  locationId: string | null;
  scrapId: string | null;
}

function makeDeps(existing: ExistingP[] = []) {
  const created: ProductCreate[] = [];
  const attach: Array<{ loc: string; ids: string[] }> = [];
  const scrapLinks: Array<{ scrapId: string; ids: string[] }> = [];
  const scrapsCreated: unknown[] = [];
  let locSeq = 0;
  let scrapSeq = 0;
  const deps: IbrsoftPacoteDeps = {
    customers: {
      customerUseCase: { create: vi.fn(async () => ({ id: "c" }) as never) },
      loadExistingCustomers: vi.fn(async () => []),
    },
    locations: {
      locationUseCase: {
        createLean: vi.fn(async (d: { code: string }) => ({ id: `loc-${++locSeq}`, code: d.code }) as never),
      },
      loadExistingCodes: vi.fn(async () => []),
    },
    scraps: {
      scrapUseCase: {
        create: vi.fn(async (d: unknown) => {
          scrapsCreated.push(d);
          return { id: `s-${++scrapSeq}` } as never;
        }),
      },
      loadExistingScraps: vi.fn(async () => []),
      loadLocationCodes: vi.fn(async () => []),
    },
    finance: {
      financeUseCase: { create: vi.fn(async () => ({ id: "f" }) as never) },
      loadCustomers: vi.fn(async () => []),
      loadExistingMarkers: vi.fn(async () => []),
    },
    nfe: {
      createHistoric: vi.fn(async () => ({ id: "n" })),
      loadExisting: vi.fn(async () => []),
      ajustarProximoNumero: vi.fn(async () => {}),
    },
    loadProductsBySkuNormalized: vi.fn(async (_u: string, norms: string[]) => [
      ...existing.filter((e) => e.skuNormalized && norms.includes(e.skuNormalized)),
      ...existing.filter((e) => e.skuNormalized === null),
    ]),
    productUseCase: {
      create: vi.fn(async (d: ProductCreate) => {
        created.push(d);
        return { id: `p-${created.length}` } as never;
      }),
    },
    attachProducts: vi.fn(async (loc: string, ids: string[]) => {
      attach.push({ loc, ids });
      return {
        attached: ids.map((id) => ({ id, sku: id, name: id })),
        alreadyAttached: [],
        skipped: [],
        location: { id: loc, code: loc, productsCount: ids.length, maxCapacity: 0 },
      } as never;
    }) as IbrsoftPacoteDeps["attachProducts"],
    linkScrapMany: vi.fn(async (scrapId: string, ids: string[]) => {
      scrapLinks.push({ scrapId, ids });
      return { count: ids.length };
    }),
  };
  return { deps, created, attach, scrapLinks, scrapsCreated };
}

// Pacote sintético: 1 sucata (placa ABC1234), 1 produto novo nessa placa +
// localização, 1 produto que JÁ existe (casa por SKU).
const PACOTE = (): ImportFile[] => [
  file(H.sucatas, ["g1;7;;t;Ativa;;;;;;;;;VW;GOL;;2010;PRETO;ABC1234;9BWAG4124FT592152;;;8708;1500"], "sucatas.csv"),
  file(H.localizacoes, ["g1;A;Barr;BARR. > CX 1;;;;;t;;;;;5"], "localizacoes.csv"),
  file(
    H.produtos,
    [
      "NOVO1;;;Farol;UN;3;12.5;160;Ford;KA;;;;BARR. > CX 1;ABC1234;8708",
      "EXISTE1;;;Lanterna;UN;1;0;90;Fiat;Uno;;;;BARR. > CX 1;;",
    ],
    "produtos.csv",
  ),
  file(H.costumers, ["g1;t;Pessoa fisica;JOAO;;52998224725;;;;;"], "costumers.csv"),
  file(H.nfe, ["g1;5;;35200114200166000187550010000000051000000019;;F;Saida;Autorizada;40;VENDA"], "nfe.csv"),
  file(H.pagar, ["g1;PAGAR;Parcial;F;12345678909;D;;1;1;10;0;10;;;2024-01-01;2024-01-01;;;f;f"], "contas_a_pagar.csv"),
];

const ctx = (dryRun: boolean, files: ImportFile[]): ImportContext => ({
  targetUserId: "admin-1",
  files: detectAndValidate("IBRSOFT", "PACOTE", files).files,
  dryRun,
});

describe("import/ibrsoft — executor PACOTE", () => {
  it("PRÉVIA (dryRun) não escreve NADA em nenhuma fase", async () => {
    const { deps, created, attach, scrapLinks } = makeDeps([
      { id: "p-ex", sku: "EXISTE1", skuNormalized: "existe1", locationId: null, scrapId: null },
    ]);
    const report = await runIbrsoftPacote(ctx(true, PACOTE()), deps);

    expect(deps.productUseCase.create).not.toHaveBeenCalled();
    expect(deps.customers.customerUseCase.create).not.toHaveBeenCalled();
    expect(deps.scraps.scrapUseCase.create).not.toHaveBeenCalled();
    expect(deps.finance.financeUseCase.create).not.toHaveBeenCalled();
    expect(deps.nfe.createHistoric).not.toHaveBeenCalled();
    expect(deps.locations.locationUseCase.createLean).not.toHaveBeenCalled();
    expect(attach).toEqual([]);
    expect(scrapLinks).toEqual([]);
    expect(created).toEqual([]);
    // Todas as fases presentes no relatório.
    expect(Object.keys(report.porFase ?? {}).sort()).toEqual(
      ["clientes", "contas_a_pagar", "localizacoes", "nfe", "produtos", "sucatas"].sort(),
    );
  });

  it("APPLY: cria o faltante (com localização+sucata), vincula o existente e liga sucata por placa", async () => {
    const { deps, created, attach, scrapLinks } = makeDeps([
      { id: "p-ex", sku: "EXISTE1", skuNormalized: "existe1", locationId: null, scrapId: null },
    ]);
    const report = await runIbrsoftPacote(ctx(false, PACOTE()), deps);

    // Produto NOVO criado com localização real + scrapId (vínculo por placa).
    expect(created).toHaveLength(1);
    expect(created[0].sku).toBe("NOVO1");
    expect(created[0].quality).toBe("SEMINOVO");
    expect(created[0].locationId).toBeTruthy();
    expect(created[0].scrapId).toBe("s-1"); // sucata criada na fase 3
    expect((created[0].attributes as Record<string, { value_name?: string }>).migration.value_name).toBe("IBRSOFT");

    // Produto EXISTENTE (EXISTE1) → attach à localização.
    expect(attach.some((a) => a.ids.includes("p-ex"))).toBe(true);

    // Sem produto existente com placa → linkScrapMany não chamado para ele
    // (o novo levou a sucata no create). Garante que nada duplicou.
    expect(report.contadores.produtos_criados).toBe(1);
    expect(report.contadores.produtos_vinculados).toBe(1);
    void scrapLinks;
  });

  it("ANTI-DUPLICAÇÃO: SKU existente com skuNormalized NULL casa e NÃO recria", async () => {
    // Produto legado sem skuNormalized (backfill não rodou). O IN não o pega;
    // o preload dos NULL deve casá-lo por normalizeSku(sku).
    const { deps, created } = makeDeps([
      { id: "p-legado", sku: "NOVO1", skuNormalized: null, locationId: null, scrapId: null },
    ]);
    await runIbrsoftPacote(ctx(false, PACOTE()), deps);
    // NOVO1 casa com o legado → não recria; EXISTE1 não existe aqui → cria.
    expect(created.map((c) => c.sku)).toEqual(["EXISTE1"]);
  });
});

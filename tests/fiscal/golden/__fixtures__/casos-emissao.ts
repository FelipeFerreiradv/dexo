/**
 * Casos determinísticos compartilhados pelos goldens de payload Focus e XML
 * SEFAZ (F0). Mesmo draft/config/número nos dois builders — assim uma mudança
 * aditiva que vaze para fora do seu contexto aparece nos DOIS goldens.
 *
 * Nada aqui depende de relógio, aleatoriedade ou ambiente: datas são fixas e a
 * flag de frete é declarada por caso (o spec aplica com vi.stubEnv).
 */

import type { NfeDraftResponse } from "../../../../app/interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../../../app/interfaces/company-fiscal.interface";
import { montarChave, chaveToString } from "../../../../app/fiscal/sefaz/chave-acesso";
import { makeConfig, makeDraft, makeItem } from "../../__helpers__/test-draft";

export interface CasoEmissao {
  nome: string;
  draft: () => NfeDraftResponse;
  config: () => CompanyFiscalConfig;
  numero: number;
  /** Valor de NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED durante o build. */
  freteFlag: "true" | "false";
}

/** dhEmi fixo usado pelos goldens SEFAZ (horário de Brasília). */
export const DH_EMI_FIXO = new Date("2026-09-17T10:30:00-03:00");
/** cNF fixo (nunca 12345678/11111111 — ambos vetados pela Rejeição 897). */
export const CNF_FIXO = "87654321";

/** Chave de 44 dígitos com DV válido de uma NF-e "original" (nº 100). */
export const CHAVE_ORIGINAL = chaveToString(
  montarChave({
    uf: "SP",
    ano: 2026,
    mes: 8,
    cnpj: "11222333000181",
    modelo: "55",
    serie: 1,
    numero: 100,
    tpEmis: 1,
    cNF: CNF_FIXO,
  }),
);

const TRIBUTOS_ZERO = makeItem().tributosJson;

function draftDevolucao(notasReferenciadasJson: unknown): NfeDraftResponse {
  return makeDraft({
    tipoOperacao: "ENTRADA",
    finalidade: "DEVOLUCAO",
    naturezaOperacao: "DEVOLUCAO DE VENDA",
    notasReferenciadasJson: notasReferenciadasJson as any,
    destinatarioJson: {
      tipoPessoa: "PF",
      cpfCnpj: "12345678909",
      nome: "CONSUMIDOR DEVOLUCAO",
      inscricaoEstadual: null,
      email: null,
      telefone: null,
      cep: "04000000",
      logradouro: "RUA DO CONSUMIDOR",
      numero: "12",
      complemento: "APTO 3",
      bairro: "JARDIM",
      municipio: "SAO PAULO",
      codMunicipio: "3550308",
      uf: "SP",
      codPais: "1058",
      pais: "BRASIL",
    } as any,
    itens: [makeItem({ cfop: "1202", descricao: "PECA DEVOLVIDA" })],
    informacoesComplementares: `Devolucao referente a NF-e ${CHAVE_ORIGINAL}`,
  });
}

function draftFrete(): NfeDraftResponse {
  return makeDraft({
    modalidadeFrete: "CIF",
    valorFrete: 30.5,
    transportadoraJson: {
      cpfCnpj: "12345678000195",
      nome: "TRANSPORTES TESTE LTDA",
      inscricaoEstadual: "987.654.321",
      endereco: "RUA DO FRETE 10",
      municipio: "CAMPINAS",
      uf: "SP",
    },
    volumesJson: [
      {
        quantidade: 2,
        especie: "CAIXA",
        marca: "DEXO",
        numeracao: "001",
        pesoLiquido: 9.5,
        pesoBruto: 10.25,
        comprimentoCm: 40,
        larguraCm: 30,
        alturaCm: 20,
      },
    ] as any,
    itens: [
      makeItem({ descricao: "PARA-CHOQUE", valorUnitario: 100, valorTotal: 100 }),
      makeItem({
        id: "item-2",
        numero: 2,
        codigo: "PROD-002",
        descricao: "FAROL",
        valorUnitario: 25,
        quantidade: 2,
        valorTotal: 50,
      }),
    ],
    totaisJson: {
      totalProdutos: 150,
      totalDesconto: 0,
      totalBcIcms: 0,
      totalIcms: 0,
      totalBcIpi: 0,
      totalIpi: 0,
      totalPis: 0,
      totalCofins: 0,
      totalNota: 180.5,
      totalTributos: 0,
    },
  });
}

export const CASOS_EMISSAO: CasoEmissao[] = [
  {
    nome: "simples-55-item-unico",
    draft: () => makeDraft(),
    config: () => makeConfig(),
    numero: 101,
    freteFlag: "false",
  },
  {
    nome: "lucro-presumido-multi-itens-desconto",
    draft: () =>
      makeDraft({
        ambiente: "PRODUCAO",
        destinoOperacao: "INTERESTADUAL",
        indPresenca: "INTERNET",
        numeroPedido: "PED-77",
        informacoesComplementares: "Garantia de 90 dias",
        dataEmissao: new Date("2026-09-17T13:30:00.000Z"),
        dataSaida: new Date("2026-09-18T11:00:00.000Z"),
        destinatarioJson: {
          tipoPessoa: "PJ",
          cpfCnpj: "44.555.666/0001-70",
          nome: "OFICINA DESTINO LTDA",
          inscricaoEstadual: "123456789012",
          email: "compras@oficina.test",
          telefone: "(21) 3333-4444",
          cep: "20000-000",
          logradouro: "AV RIO BRANCO",
          numero: "1",
          complemento: null,
          bairro: "CENTRO",
          municipio: "RIO DE JANEIRO",
          codMunicipio: "3304557",
          uf: "RJ",
          codPais: "1058",
          pais: "BRASIL",
        },
        itens: [
          makeItem({
            cstIcms: "00",
            cstPis: "01",
            cstCofins: "01",
            quantidade: 2,
            valorUnitario: 50,
            valorTotal: 100,
            desconto: 10,
            tributosJson: {
              bcIcms: 90,
              valorIcms: 10.8,
              aliquotaIcms: 12,
              bcIpi: 0,
              valorIpi: 0,
              aliquotaIpi: 0,
              bcPis: 90,
              valorPis: 1.49,
              aliquotaPis: 1.65,
              bcCofins: 90,
              valorCofins: 6.84,
              aliquotaCofins: 7.6,
              valorTotalTributos: 19.13,
            },
          }),
          makeItem({
            id: "item-2",
            numero: 2,
            codigo: "PROD-002",
            descricao: "SENSOR ABS",
            ncm: "90318099",
            cfop: "6102",
            cest: "0100100",
            origem: 1,
            unidade: "PC",
            quantidade: 1.5,
            valorUnitario: 33.3333,
            valorTotal: 50,
            cstIcms: "00",
            cstPis: "01",
            cstCofins: "01",
            tributosJson: TRIBUTOS_ZERO,
          }),
          makeItem({
            id: "item-3",
            numero: 3,
            codigo: "PROD-003",
            descricao: "JUNTA",
            cfop: "6102",
            cstIcms: null,
            cstPis: null,
            cstCofins: null,
            quantidade: 3,
            valorUnitario: 10,
            valorTotal: 30,
            tributosJson: TRIBUTOS_ZERO,
          }),
        ],
        totaisJson: {
          totalProdutos: 180,
          totalDesconto: 10,
          totalBcIcms: 90,
          totalIcms: 10.8,
          totalBcIpi: 0,
          totalIpi: 0,
          totalPis: 1.49,
          totalCofins: 6.84,
          totalNota: 170,
          totalTributos: 19.13,
        },
        duplicatasJson: [
          { numero: "001", dataVencimento: "2026-10-17", valor: 85 },
          { numero: "002", dataVencimento: "2026-11-17", valor: 85 },
        ] as any,
        pagamentosJson: [{ meio: "BOLETO", valor: 170 }] as any,
      }),
    config: () =>
      makeConfig({
        ambiente: "PRODUCAO",
        regimeTributario: "LUCRO_PRESUMIDO",
        inscricaoMunicipal: "998877",
        cnae: "4530703",
        complemento: "SALA 2",
      }),
    numero: 101,
    freteFlag: "false",
  },
  {
    nome: "modelo-65",
    draft: () =>
      makeDraft({
        modelo: "65",
        serie: 2,
        indPresenca: "PRESENCIAL",
        destinatarioJson: null,
        pagamentosJson: [
          { meio: "CARTAO_CREDITO", valor: 60 },
          { meio: "DINHEIRO", valor: 40 },
        ] as any,
      }),
    config: () => makeConfig(),
    numero: 7,
    freteFlag: "false",
  },
  {
    nome: "frete-flag-ligada",
    draft: draftFrete,
    config: () => makeConfig(),
    numero: 101,
    freteFlag: "true",
  },
  {
    nome: "frete-flag-desligada",
    draft: draftFrete,
    config: () => makeConfig(),
    numero: 101,
    freteFlag: "false",
  },
  {
    nome: "devolucao-entrada-com-referencia",
    draft: () => draftDevolucao([{ chaveAcesso: CHAVE_ORIGINAL }]),
    config: () => makeConfig(),
    numero: 101,
    freteFlag: "false",
  },
  {
    nome: "devolucao-entrada-sem-referencia",
    draft: () => draftDevolucao(null),
    config: () => makeConfig(),
    numero: 101,
    freteFlag: "false",
  },
  {
    nome: "pagamentos-vazio",
    draft: () => makeDraft({ pagamentosJson: [] as any }),
    config: () => makeConfig(),
    numero: 101,
    freteFlag: "false",
  },
  {
    nome: "pagamentos-preenchido",
    draft: () =>
      makeDraft({
        pagamentosJson: [
          { meio: "PIX", valor: 50 },
          { meio: "CARTAO_DEBITO", valor: 30 },
          { meio: "DINHEIRO", valor: 20 },
        ] as any,
      }),
    config: () => makeConfig(),
    numero: 101,
    freteFlag: "false",
  },
];

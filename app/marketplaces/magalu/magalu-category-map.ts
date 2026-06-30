// De-para CURADO: tipo de peça → id da categoria Magalu.
//
// Por quê: a busca por nome (/categories?name=) acerta o DOMÍNIO ("Veículos e
// Peças") mas erra o LEAF para autopeças usadas (taxonomia genérica + similaridade
// que aproxima peças diferentes — ex.: "tampa de reservatório" cai em "Junta da
// Tampa de Válvula"). O mapa é consultado ANTES da busca: casamento por PREFIXO
// mais longo do nome do produto (normalizado: minúsculas, sem acento).
//
// Como popular (descobrir o id certo de um tipo):
//   npx tsx scripts/test-magalu-create-listing.ts --user-id=... --find-category="tampa reservatorio"
//   → lista os candidatos; pegue o id da linha marcada com ★ (path em Veículos e
//     Peças) que melhor descreve a peça e adicione abaixo.
//
// Escopo: v1 GLOBAL (a Jotabê é o único seller Magalu hoje). Se entrar outro
// seller com taxonomia própria, migrar para um mapa por conta (DB).
//
// Validado contra a API real (Jotabê, 2026-06-29). O comentário ao lado de cada
// entrada é o `path` da categoria, para auditoria.
export const MAGALU_CATEGORY_MAP: Record<string, string> = {
  farol: "298cf208-e58e-4783-80e5-c907c01f7e0d", // Veículos e Peças/Luzes Veiculares/Farol para Veículos
  lanterna: "e1c2e4f9-0db4-431f-b9d2-f5bce0e6eb19", // Veículos e Peças/Luzes Veiculares/Lanterna para Veículos
  retrovisor: "7fd0ed06-3522-451d-b00c-c9452b5d116d", // Veículos e Peças/Carroceria e Acabamento/Retrovisor
  radiador: "bf433bbf-b01e-4d73-9633-38bc5de6222d", // Veículos e Peças/Suspensão e Direção/Radiador
  alternador: "34baa2da-6434-4d1e-b35e-6d448a196ea9", // Veículos e Peças/Elétrica e Ignição/Alternador para Veículos
  fechadura: "7e199d1c-1f47-4a09-9d53-7025e55ba127", // Veículos e Peças/Segurança de Veículos/Fechadura para Veículos
  coxim: "cbbf6737-0c76-4fe8-a1c5-fcfee54438dc", // Veículos e Peças/Peças de Motor/Coxim para Veículos (genérico)
  amortecedor: "50fbb195-775f-43cc-9937-67d321308bea", // Veículos e Peças/Suspensão e Direção/Amortecedor
  ventoinha: "433ff78a-64b5-4887-9de1-31b5f4bc3f7c", // Veículos e Peças/Suspensão e Direção/Ventoinha para Veículos
  catalisador: "53d12995-8bd9-4e5a-9309-ce328913a723", // Veículos e Peças/Peças de Motor/Catalisador
  // Variações de grafia do produto p/ casar o prefixo (com/sem "de"/hífen/espaço).
  "compressor ar condicionado": "d3eb14cc-b5c4-4bad-8e42-57a71e6423e4", // Veículos e Peças/Suspensão e Direção/Compressor de Ar-condicionado para Veículos
  "compressor de ar condicionado": "d3eb14cc-b5c4-4bad-8e42-57a71e6423e4",
  "para-choque": "cf6f0f23-0dcc-45ca-9bd0-1c63a0460f5a", // Veículos e Peças/Carroceria e Acabamento/Para-choque
  parachoque: "cf6f0f23-0dcc-45ca-9bd0-1c63a0460f5a",
  "para choque": "cf6f0f23-0dcc-45ca-9bd0-1c63a0460f5a",
  "disco de freio": "9ae6c77e-f70f-4985-95c1-a703de800e4d", // Veículos e Peças/Freios para Veículos/Disco de Freio
  "semi eixo": "04248494-b5db-446f-bdc3-617667950961", // Veículos e Peças/Suspensão e Direção/Semi Eixo
  semieixo: "04248494-b5db-446f-bdc3-617667950961",
  "semi-eixo": "04248494-b5db-446f-bdc3-617667950961",

  // SEM leaf bom na taxonomia da Magalu (deixados de fora → busca/DRAFT seguro):
  //   capo/capô (só "capota marítima"), porta (só "antifurto"), grade/painel/banco
  //   (só capa/moldura/acabamento), sensor genérico (cairia em "Sensor ABS").
  //   0 resultados: motor de arranque/partida, reservatorio, paralama, macaneta,
  //   bomba dagua, cambio, modulo, caixa de direcao, corpo de borboleta, pinca de freio.
};

// O registry das tools de ESCRITA. Fase 9.
//
// ⭐ NENHUMA DELAS ESCREVE. Todas param na PROPOSTA: validam, resolvem o alvo
// dentro do tenant, montam o resumo do que mudaria e gravam uma linha em
// `AiAction` com status "pendente". Quem escreve é o clique do lojista em
// `POST /ai/acoes/:id/confirmar`.
//
// ⛔ E NENHUMA APAGA. Não há tool de exclusão aqui e não vai haver: é regra do
// dono do produto, e a ausência é mais forte que qualquer validação — não
// existe caminho para o modelo pedir, porque não existe a ferramenta.
//
// ⚠️ TODA TOOL DESTA LISTA DECLARA `action`. Escrita atrás de permissão de
// página só seria escrita sem dono; o tool-runner barra quem não declarar, e
// `ai-write-tools.spec.ts` falha antes disso.

import type { AiTool } from "../registry";
import { pausarOuReativarAnuncio } from "./anuncios";
import { cadastrarCliente } from "./clientes";
import { completarFiscalDaSucata } from "./fiscal-sucata";
import { lembrarPreferencia } from "./memoria";
import {
  ajustarEstoqueDoProduto,
  alterarPrecoDoProduto,
  cadastrarPecasEmMassa,
  cadastrarProduto,
} from "./produtos";
import { cadastrarSucata, vincularPecaASucata } from "./sucatas";

export const WRITE_TOOLS: AiTool[] = [
  cadastrarProduto,
  cadastrarPecasEmMassa,
  alterarPrecoDoProduto,
  ajustarEstoqueDoProduto,
  cadastrarCliente,
  cadastrarSucata,
  vincularPecaASucata,
  completarFiscalDaSucata,
  // ⭐ A primeira que toca o CANAL, e não o catálogo. Ao confirmar, a peça sai
  // do ar (ou volta) no marketplace na hora.
  pausarOuReativarAnuncio,
  // ⭐ A única que não escreve em tabela de negócio: ela ensina uma REGRA ao
  // agente. Passa pelo mesmo cartão porque o alcance é maior, não menor — o que
  // se ensina vale para a equipe inteira, em todo turno, até alguém apagar.
  lembrarPreferencia,
];

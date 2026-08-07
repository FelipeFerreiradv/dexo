// O registry das tools CONSULTIVAS.
//
// A diferença entre uma tool de leitura e uma consultiva não é técnica, é de
// contrato com o usuário:
//
//   leitura     devolve um FATO do sistema. "Você tem 3 no estoque."
//   consultiva  devolve uma RECOMENDAÇÃO, e é obrigada a dizer de onde ela veio.
//
// Por isso toda tool daqui devolve um campo `fontes` (AiSource[]) montado pelo
// SERVIDOR a partir do degrau da cadeia que respondeu. O modelo não escreve
// esse campo, não consegue esquecê-lo e não consegue inventar uma procedência
// que não existiu. Quando `fontes` vem vazio é porque não houve base — e aí o
// retorno carrega uma instrução explícita de NÃO estimar.
//
// Todas são `page: "produtos"`: recomendar preço, medida, categoria ou título é
// trabalho de quem cadastra peça. Colaborador sem acesso a Produtos recebe
// recusa no tool-runner, dentro da conversa.

import { buildRegistry, type AiTool } from "../registry";
import { consultarCatalogoMl } from "./catalogo-ml";
import { sugerirCategoria } from "./categoria";
import { sugerirCompatibilidades } from "./compatibilidades";
import { sugerirDescricao } from "./descricao";
import { sugerirMedidas } from "./medidas";
import { sugerirPreco } from "./preco";
import { sugerirTitulo } from "./titulo";

export const ADVISORY_TOOLS: AiTool[] = [
  sugerirPreco,
  sugerirMedidas,
  sugerirCompatibilidades,
  sugerirCategoria,
  sugerirTitulo,
  sugerirDescricao,
  consultarCatalogoMl,
];

let cache: Map<string, AiTool> | null = null;

export function getAdvisoryToolRegistry(): Map<string, AiTool> {
  if (!cache) cache = buildRegistry(ADVISORY_TOOLS);
  return cache;
}

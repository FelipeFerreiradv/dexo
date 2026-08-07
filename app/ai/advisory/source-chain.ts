// ⭐ A hierarquia de fontes.
//
// ESTE ARQUIVO É A DECISÃO CENTRAL DA FASE 6, e o que ele resolve é isto:
// "consulte primeiro os dados do cliente, depois a base consolidada, e só
// depois chute" é uma frase. Frase, o modelo cumpre quando quer. A hierarquia
// aqui é ORDEM DE EXECUÇÃO em código — a fonte 5 não é consultada quando a 1
// respondeu porque a função `buscar` dela NUNCA É CHAMADA, não porque alguém
// pediu por favor no prompt.
//
// A ordem canônica, do mais específico para o mais genérico:
//
//   1. proprio       o catálogo do próprio cliente (dado dele, sobre a loja dele)
//   2. plataforma    CatalogStat — agregado de TODAS as lojas, mínimo de 5 amostras
//   3. conhecimento  a base de conhecimento sobre o Dexo
//   4. regra         regra determinística do sistema (limite de canal, tabela de medida)
//   5. externa       catálogo público do ML — atrás de AI_EXTERNAL_LOOKUP_ENABLED
//   6. estimativa    conhecimento geral do modelo, e a resposta DIZ que é estimativa
//
// Três invariantes valem para toda cadeia, e cada um existe por um motivo
// concreto:
//
//  A. PARA NO PRIMEIRO QUE RESPONDE. Economia de custo e de latência, sim, mas
//     principalmente de EGRESS: enquanto a fonte 1 responder, o título que o
//     lojista digitou não sai da máquina.
//
//  B. `externa` SÓ RODA COM A FLAG LIGADA. A flag nasce desligada. O gate mora
//     aqui, e não em cada tool, porque "esqueci de checar a flag naquela tool"
//     é o defeito que a revisão humana não pega.
//
//  C. UM DEGRAU NUNCA REPORTA PROCEDÊNCIA MAIS FORTE DO QUE A DELE. Um passo
//     declarado `plataforma` pode reportar `regra` (mais fraca) — é o caso real
//     do motor de categoria, que diz sozinho se a resposta veio do CatalogStat
//     ou do mapa curado. Reportar `proprio` num passo `externa` seria mentir
//     sobre a origem no card de fontes, e isso falha ALTO.
//
// Falha de uma fonte NUNCA derruba a cadeia: vira `falhou` na trilha e a
// próxima é tentada. Uma sugestão é conveniência — o turno não pode morrer
// porque o catálogo do ML estava fora do ar.

import { isAiExternalLookupEnabled } from "../core/ai-constants";
import type { AiSource } from "../core/types";

/** A ordem canônica. O índice no array É a força da fonte. */
export const ORDEM_DAS_FONTES = [
  "proprio",
  "plataforma",
  "conhecimento",
  "regra",
  "externa",
  "estimativa",
] as const;

export type NivelDeFonte = (typeof ORDEM_DAS_FONTES)[number];

const FORCA = new Map<string, number>(
  ORDEM_DAS_FONTES.map((nivel, i) => [nivel, i]),
);

export interface AchadoDaFonte<T> {
  valor: T;
  /** A procedência que o usuário vê no card. Montada pelo SERVIDOR. */
  fonte: AiSource;
}

export interface Degrau<T> {
  nivel: NivelDeFonte;
  /**
   * Executa a fonte. `null` significa "não tenho resposta" — e aí a cadeia
   * segue para o próximo degrau. Lançar também é aceitável: vira `falhou`.
   */
  buscar: () => Promise<AchadoDaFonte<T> | null>;
}

export type StatusDoPasso =
  "respondeu" | "vazio" | "pulado_por_flag" | "falhou";

export interface PassoDaTrilha {
  nivel: NivelDeFonte;
  status: StatusDoPasso;
  ms: number;
}

export interface ResultadoDaCadeia<T> {
  valor: T | null;
  fonte: AiSource | null;
  nivel: NivelDeFonte | null;
  /**
   * Todos os degraus TENTADOS, na ordem, e o que aconteceu em cada um.
   *
   * Não é enfeite: é o que torna o invariante A observável. Um teste que só
   * olha o resultado final não distingue "a fonte externa não respondeu" de
   * "a fonte externa nem foi consultada" — e a diferença entre as duas é a
   * decisão inteira desta fase.
   */
  trilha: PassoDaTrilha[];
}

/**
 * Executa a cadeia na ordem e para no primeiro degrau que responder.
 *
 * Lança em erro de PROGRAMAÇÃO (degraus fora da ordem canônica, procedência
 * mais forte que o degrau) — igual a `buildRegistry` com nome duplicado. Uma
 * cadeia montada errada é defeito de autoria, e falhar alto na suíte é
 * infinitamente melhor do que descobrir em produção que a pesquisa externa
 * rodou antes do catálogo do cliente.
 */
export async function resolverNaOrdem<T>(
  degraus: Degrau<T>[],
): Promise<ResultadoDaCadeia<T>> {
  garantirOrdem(degraus);

  const trilha: PassoDaTrilha[] = [];

  for (const degrau of degraus) {
    // Invariante B: o gate da pesquisa externa é CENTRAL.
    if (degrau.nivel === "externa" && !isAiExternalLookupEnabled()) {
      trilha.push({ nivel: degrau.nivel, status: "pulado_por_flag", ms: 0 });
      continue;
    }

    const inicio = Date.now();
    let achado: AchadoDaFonte<T> | null = null;
    try {
      achado = await degrau.buscar();
    } catch (err) {
      // Fonte indisponível não é erro do turno. O log fica no servidor.
      console.error(`[bitz-fonte] ${degrau.nivel} falhou:`, err);
      trilha.push({
        nivel: degrau.nivel,
        status: "falhou",
        ms: Date.now() - inicio,
      });
      continue;
    }

    const ms = Date.now() - inicio;

    if (!achado) {
      trilha.push({ nivel: degrau.nivel, status: "vazio", ms });
      continue;
    }

    garantirProcedencia(degrau.nivel, achado.fonte);
    trilha.push({ nivel: degrau.nivel, status: "respondeu", ms });

    // Invariante A: acabou. Os degraus seguintes não são executados.
    return {
      valor: achado.valor,
      fonte: achado.fonte,
      nivel: degrau.nivel,
      trilha,
    };
  }

  return { valor: null, fonte: null, nivel: null, trilha };
}

/** Invariante: os degraus vêm na ordem canônica (empate permitido). */
function garantirOrdem(degraus: Degrau<unknown>[]): void {
  let anterior = -1;
  for (const degrau of degraus) {
    const forca = FORCA.get(degrau.nivel);
    if (forca === undefined) {
      throw new Error(`[bitz] nível de fonte desconhecido: ${degrau.nivel}`);
    }
    if (forca < anterior) {
      throw new Error(
        `[bitz] cadeia de fontes fora de ordem: "${degrau.nivel}" depois de um degrau mais genérico. ` +
          `A ordem é ${ORDEM_DAS_FONTES.join(" > ")}.`,
      );
    }
    anterior = forca;
  }
}

/** Invariante C: a procedência reportada não pode ser mais forte que o degrau. */
function garantirProcedencia(nivel: NivelDeFonte, fonte: AiSource): void {
  const forcaDoDegrau = FORCA.get(nivel)!;
  const forcaDaFonte = FORCA.get(fonte.kind);
  if (forcaDaFonte === undefined) {
    throw new Error(`[bitz] fonte com kind desconhecido: ${fonte.kind}`);
  }
  if (forcaDaFonte < forcaDoDegrau) {
    throw new Error(
      `[bitz] degrau "${nivel}" reportou procedência "${fonte.kind}", que é mais forte. ` +
        `Um passo pode se declarar mais fraco do que é, nunca mais forte.`,
    );
  }
}

/**
 * A cadeia respondeu alguma coisa?
 *
 * Existe como função nomeada porque a checagem aparece nas 7 tools e "valor
 * !== null" espalhado é o tipo de condição que alguém inverte numa refatoração.
 */
export function respondeu<T>(r: ResultadoDaCadeia<T>): boolean {
  return r.valor !== null && r.fonte !== null;
}

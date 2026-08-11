"use client";

/**
 * Os dois marcos de "primeira vez" do Bitz.
 *
 * O widget tem duas animações que tocam UMA VEZ NA VIDA de cada usuário:
 *
 *  - `entrada`      — o robô saindo do canto da tela, 9,6 s, no primeiro clique
 *                     de todos no launcher.
 *  - `apresentacao` — a tela "Conheça o Bitz" com o robô em loop, mostrada até
 *                     a primeira mensagem enviada.
 *
 * Depois disso o chat abre direto e "nova conversa" cai na tela de boas-vindas
 * de sempre (sugestões, temas, exemplos). Foi assim que o produto pediu, e a
 * razão é boa: uma entrada de 9,6 s e 1 MB é encantadora na primeira vez e
 * insuportável na décima.
 *
 * ⭐ POR QUE `localStorage` E NÃO O BANCO. A decisão precisa estar pronta NO
 * INSTANTE DO CLIQUE — não dá para buscar `GET /ai/conversations` e só então
 * decidir se anima, porque isso põe a rede no caminho de um efeito visual. Sem
 * requisição, sem DDL, sem coluna nova. O preço é conhecido e barato: em outro
 * navegador o usuário vê a entrada mais uma vez.
 *
 * ⚠️ A LEITURA FALHA FECHADA. `localStorage` lança em modo privado do Safari,
 * em iframe com storage particionado e quando a política do navegador bloqueia
 * o site. Nesses casos `jaPassou` devolve **true**, ou seja: NÃO anima.
 *
 * O motivo forte vale para a ENTRADA: falhar aberto faria 9,6 s e 1 MB tocarem
 * em toda abertura, para sempre, exatamente para quem já está num navegador
 * restrito. Perder o encanto é aceitável; virar pedágio não é.
 *
 * Para a APRESENTAÇÃO o argumento é mais fraco, e é honesto dizer isso: 235 KB
 * não são pedágio nenhum. O que decide ali é a consistência — com storage
 * quebrado o marco também não pode ser GRAVADO, então falhar aberto significa
 * a tela "Conheça o Bitz" reaparecendo a cada carregamento de página até a
 * pessoa escrever algo. Um navegador só, duas regras diferentes, seria pior de
 * explicar do que a perda de uma tela de boas-vindas.
 */

/** Namespace próprio: o mesmo domínio serve todo o Dexo. */
const PREFIXO = "dexo:bitz:";

export type BitzMarco = "entrada" | "apresentacao";

/**
 * A chave é POR USUÁRIO. Numa loja em que o dono e o balconista usam a mesma
 * máquina, quem entra depois merece ver a apresentação também.
 */
function chave(usuarioId: string, marco: BitzMarco): string {
  return `${PREFIXO}${marco}:${usuarioId}`;
}

/** Este usuário já passou por este marco? Em caso de dúvida, sim (ver acima). */
export function jaPassou(usuarioId: string, marco: BitzMarco): boolean {
  if (!usuarioId) return true;
  try {
    return window.localStorage.getItem(chave(usuarioId, marco)) === "1";
  } catch {
    return true;
  }
}

/** Registra o marco. Silencioso: storage indisponível já implica em não animar. */
export function marcarPassou(usuarioId: string, marco: BitzMarco): void {
  if (!usuarioId) return;
  try {
    window.localStorage.setItem(chave(usuarioId, marco), "1");
  } catch {
    // Sem storage não há o que gravar — e `jaPassou` devolve true nesse
    // cenário, então nada se repete de qualquer forma.
  }
}

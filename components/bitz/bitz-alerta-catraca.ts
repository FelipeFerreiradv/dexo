"use client";

/**
 * ⭐⭐ A CATRACA — a peça que decide se o badge do mascote é um SINAL ou um
 * PAPEL DE PAREDE.
 *
 * O problema é real e foi medido: quase toda pendência de importação em
 * produção está em `NEEDS_ACTION`, o estado que o reconciliador automático NÃO
 * resolve sozinho (order-ingestion-reconciler.service.ts:65). Numa loja são 61
 * delas; noutra, 57. Elas não vão embora amanhã.
 *
 * Um badge por EXISTÊNCIA ("há 61 problemas") nasceria ligado e ficaria ligado
 * para sempre. Em duas semanas o lojista para de enxergá-lo — e no dia em que
 * aparecer o problema NOVO, o ponto vermelho não vai dizer nada, porque ele já
 * estava lá.
 *
 * Então o badge não é por existência: é por PIORA. O lojista dispensa uma vez, e
 * o alerta só volta quando algum número SOBE.
 *
 * ⚠️ E A CATRACA GIRA NOS DOIS SENTIDOS, que é a parte que erra fácil. Sem
 * baixar a marca quando o número CAI, este seria o caminho:
 *
 *     dispensou com 61  →  o lojista resolve tudo, cai para 0  →  aparece 1
 *     pendência NOVA  →  1 > 61 é falso  →  ⛔ NENHUM AVISO, nunca mais.
 *
 * Por isso `avaliar` REGRAVA a marca para baixo assim que vê um número menor. A
 * marca sempre persegue o piso, e qualquer subida a partir dele avisa.
 *
 * ⚠️ FALHA FECHADA, pelo mesmo motivo do `bitz-onboarding.ts`: sem
 * `localStorage` não há como GRAVAR a dispensa, então um badge mostrado ali seria
 * um badge que o usuário não consegue desligar — de novo, em toda página, para
 * sempre. Perder o aviso é aceitável; virar pedágio não é.
 */

/** Namespace próprio: o mesmo domínio serve todo o Dexo. */
const CHAVE = "dexo:bitz:alerta:";

export interface ContagemDeAlertas {
  pedidosTravados: number;
  contasCaidas: number;
}

export const SEM_ALERTA: ContagemDeAlertas = {
  pedidosTravados: 0,
  contasCaidas: 0,
};

/** A chave é POR USUÁRIO — dono e balconista dividem a mesma máquina. */
function chave(usuarioId: string): string {
  return `${CHAVE}${usuarioId}`;
}

function ler(usuarioId: string): ContagemDeAlertas | null {
  try {
    const cru = window.localStorage.getItem(chave(usuarioId));
    if (!cru) return SEM_ALERTA;
    const o = JSON.parse(cru);
    // Número e só número: lixo no storage (outra versão, edição manual) volta
    // como marca zerada, que no pior caso avisa uma vez a mais.
    return {
      pedidosTravados: Number.isFinite(o?.pedidosTravados)
        ? Math.max(0, Math.trunc(o.pedidosTravados))
        : 0,
      contasCaidas: Number.isFinite(o?.contasCaidas)
        ? Math.max(0, Math.trunc(o.contasCaidas))
        : 0,
    };
  } catch {
    // Storage bloqueado OU JSON corrompido. `null` significa "não dá para
    // lembrar de nada" — e quem chama trata isso como "não avisa".
    return null;
  }
}

function gravar(usuarioId: string, marca: ContagemDeAlertas): void {
  try {
    window.localStorage.setItem(chave(usuarioId), JSON.stringify(marca));
  } catch {
    // Sem storage não há o que gravar — e `avaliar` já devolve `false` nesse
    // cenário, então nada se repete de qualquer forma.
  }
}

/**
 * Vale interromper com estes números?
 *
 * Só quando algum deles está ACIMA da marca que o usuário já dispensou. E, de
 * quebra, baixa a marca sempre que a realidade melhora — é isso que mantém a
 * catraca viva depois de o lojista resolver tudo.
 */
export function avaliar(
  usuarioId: string,
  atual: ContagemDeAlertas,
): boolean {
  if (!usuarioId) return false;

  const marca = ler(usuarioId);
  if (!marca) return false; // sem storage, sem badge (ver o cabeçalho)

  const piso: ContagemDeAlertas = {
    pedidosTravados: Math.min(marca.pedidosTravados, atual.pedidosTravados),
    contasCaidas: Math.min(marca.contasCaidas, atual.contasCaidas),
  };

  // ⭐ A regravação para BAIXO. Sem esta linha o alerta morre para sempre na
  // primeira vez que o lojista resolve tudo — ver o cabeçalho.
  if (
    piso.pedidosTravados !== marca.pedidosTravados ||
    piso.contasCaidas !== marca.contasCaidas
  ) {
    gravar(usuarioId, piso);
  }

  return (
    atual.pedidosTravados > piso.pedidosTravados ||
    atual.contasCaidas > piso.contasCaidas
  );
}

/** O usuário viu. A marca passa a ser o que ele viu. */
export function dispensar(
  usuarioId: string,
  atual: ContagemDeAlertas,
): void {
  if (!usuarioId) return;
  gravar(usuarioId, atual);
}

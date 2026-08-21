/**
 * Reaplicar a sucata de um rascunho restaurado, sem deixar o seletor apagar
 * o que acabou de voltar.
 *
 * O DEFEITO QUE ISTO CORRIGE (21/08/2026). O rascunho do cadastro gravava a
 * sucata escolhida — há até um efeito dedicado só para isso, porque ela vive
 * fora do react-hook-form —, e `restoreSnapshotIntoForm` nunca lia esse campo.
 * Escrita morta. Voltavam marca, modelo, ano, versão e o texto do veículo, que
 * são campos do formulário; ficava de fora o vínculo, que é o único que não
 * alimenta nenhum outro campo visível. A tela parecia completa e a peça nascia
 * sem lote — sem contar nas peças da sucata nem nos valores dela.
 *
 * POR QUE NÃO É SÓ CHAMAR `setSelectedScrap`. O modal de criação é um `<form>`,
 * e ali o Radix mantém um `<select>` NATIVO espelhando o seletor. Se o valor
 * chega sem que exista uma `<option>` com aquele id, o browser recusa e cai na
 * PRIMEIRA opção — que neste seletor é "Nenhuma sucata" — e o Radix devolve
 * isso pelo `onValueChange`. E o ramo de "Nenhuma" APAGA marca, modelo, ano,
 * versão e veículo de origem. O remédio ingênuo seria pior que a doença: em vez
 * de perder só o vínculo, perderia cinco campos junto.
 *
 * Daí a decisão vir em dois passos: primeiro a `<option>` existe, depois o
 * valor entra. É a mesma cura de `scrap-link-section.tsx`, no modal de edição.
 */

/** Forma da sucata no seletor de vínculo do cadastro. */
export interface SucataDoSeletor {
  id: string;
  brand: string;
  model: string;
  year?: string;
  version?: string;
  plate?: string;
}

/** O que o rascunho guardou. Só `id` é garantido. */
export interface SucataDoRascunho {
  id: string;
  brand?: string;
  model?: string;
  year?: string;
  version?: string;
  plate?: string;
}

export type AcaoDeRestauracao =
  /** A opção já existe: pode escrever o valor. */
  | { tipo: "aplicar"; sucata: SucataDoSeletor }
  /** A opção não existe: registrar primeiro, aplicar no commit seguinte. */
  | { tipo: "registrar-opcao"; opcao: SucataDoSeletor }
  /** Nada a fazer com segurança agora. */
  | { tipo: "esperar" };

/**
 * Decide o próximo passo da restauração.
 *
 * `esperar` cobre dois casos distintos, e ambos precisam ser inertes:
 *
 *  - não há nada pendente;
 *  - o rascunho é ANTIGO e só tem o `id` (formato anterior a 21/08/2026), e o
 *    lote não está na lista. Sem marca e modelo não dá para desenhar a opção, e
 *    inventar um rótulo seria pior do que não restaurar. O TTL de 24 horas do
 *    rascunho aposenta esses casos sozinho.
 */
export function decidirRestauracaoDaSucata(
  pendente: SucataDoRascunho | null | undefined,
  lista: readonly SucataDoSeletor[],
  /**
   * Fluxo "Adicionar peça" do detalhe do lote, em que a sucata é IMPOSTA
   * pela porta de entrada e o seletor nem é desenhado.
   */
  travado = false,
): AcaoDeRestauracao {
  if (!pendente?.id) return { tipo: "esperar" };

  // Lote travado manda, sempre. O rascunho desse fluxo é escopado só como
  // "scrap", SEM o id do lote (`create-product-dialog.tsx`), então um
  // rascunho começado no lote A pode ser oferecido dentro do lote B — e
  // restaurar o vínculo ali trocaria a peça de lote sem ninguém pedir.
  if (travado) return { tipo: "esperar" };

  // A lista é a fonte da verdade quando tem o lote: os dados dela são os do
  // servidor, e o rascunho pode estar desatualizado (a placa mudou, por
  // exemplo).
  const naLista = lista.find((s) => s.id === pendente.id);
  if (naLista) return { tipo: "aplicar", sucata: naLista };

  // Fora da lista. Acontece de verdade: `/scraps` traz só os `AVAILABLE` e no
  // máximo 100, então um lote esgotado enquanto o rascunho dormia, ou um tenant
  // com muitos lotes, cai aqui. É por isso que o rascunho guarda o veículo
  // inteiro, e não só o id.
  if (!pendente.brand || !pendente.model) return { tipo: "esperar" };

  return {
    tipo: "registrar-opcao",
    opcao: {
      id: pendente.id,
      brand: pendente.brand,
      model: pendente.model,
      year: pendente.year,
      version: pendente.version,
      plate: pendente.plate,
    },
  };
}

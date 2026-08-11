// O texto do toast que resume o re-sync de anúncios feito dentro do
// `PUT /products/:id`.
//
// Vive fora do diálogo por um motivo prático: `edit-product-dialog.tsx` passa de
// 2.500 linhas e só é exercitável com DOM. Aqui é função pura — a regra de
// "quantos sincronizaram, quantos falharam, quantos foram pulados" fica
// testável sem montar componente nenhum.
//
// ⭐ POR QUE "PULADO" PRECISOU EXISTIR.
// Antes, o resumo tinha dois estados: sucesso e falha. Quando o kill-switch de
// runtime (OLX/FACEBOOK_INTEGRATION_DISABLED) passou a valer também na edição de
// produto, apareceu um terceiro: o anúncio que NÃO foi atualizado e não falhou.
// Ele volta com `success: true` — porque a edição do lojista não falhou; quem
// pausou o canal foi o operador —, e contá-lo como "sincronizado" faria o
// sistema afirmar que o anúncio recebeu uma alteração que ele não recebeu.
// Dizer "falhou" seria igualmente errado, e mais assustador.

import { LISTING_PLATFORM_LABELS } from "./listing-status-labels";

export interface SyncResultItem {
  success?: boolean;
  externalListingId?: string;
  error?: string;
  /** Não foi enviado ao canal, e não é falha. Ver `skipReason`. */
  skipped?: boolean;
  skipReason?: string;
  platform?: string;
}

export interface ResumoDeSync {
  mensagem: string;
  tipo: "success" | "warning";
}

/** Quantos itens da falha entram no texto antes de virar "(+N)". */
const MAX_FALHAS_CITADAS = 3;

const MENSAGEM_PADRAO = "Produto atualizado com sucesso!";

/** "OLX", "Facebook" — nunca o enum cru. Desconhecido volta como veio. */
function rotuloDoCanal(platform?: string): string | null {
  if (!platform) return null;
  return (
    (LISTING_PLATFORM_LABELS as Record<string, string>)[platform] ?? platform
  );
}

/**
 * Os canais pausados citados nos pulados, já com rótulo legível. `null` quando
 * o pulo não foi por kill-switch (outro `skipReason`) ou quando o resultado não
 * trouxe plataforma — casos em que inventar um nome seria pior que omitir.
 */
function canaisPausados(pulados: SyncResultItem[]): string | null {
  const canais = Array.from(
    new Set(
      pulados
        .filter((r) => r?.skipReason === "integration_disabled")
        .map((r) => rotuloDoCanal(r?.platform))
        .filter((v): v is string => Boolean(v)),
    ),
  );
  return canais.length > 0 ? canais.join(", ") : null;
}

/**
 * Por que os pulados são descritos por CANAL e não só contados: "1 anúncio não
 * foi atualizado" deixa o lojista procurando qual. Com o canal na frase, ele
 * sabe na hora que é a integração que ele mesmo pausou — e a mensagem deixa de
 * parecer erro do sistema.
 */
function descreverPulados(pulados: SyncResultItem[]): string {
  const quantos = `${pulados.length} anúncio(s)`;
  const canais = canaisPausados(pulados);
  return canais
    ? `${quantos} não recebeu(ram) a alteração: integração pausada (${canais}).`
    : `${quantos} não recebeu(ram) a alteração.`;
}

export function resumirSync(
  resultados: SyncResultItem[] | undefined,
): ResumoDeSync {
  const lista = Array.isArray(resultados) ? resultados : [];
  if (lista.length === 0) {
    return { mensagem: MENSAGEM_PADRAO, tipo: "success" };
  }

  const pulados = lista.filter((r) => r?.skipped);
  // ⭐ O pulado sai da conta de sincronizados. É o conserto inteiro em uma linha:
  // antes bastava `r.success`, e o skip tem `success: true`.
  const sincronizados = lista.filter((r) => r?.success && !r?.skipped).length;
  const falhas = lista.filter((r) => !r?.success);

  const resumoDasFalhas = falhas
    .slice(0, MAX_FALHAS_CITADAS)
    .map(
      (r) =>
        `${r?.externalListingId || "?"}${
          r?.error ? `: ${r.error.slice(0, 80)}` : ""
        }`,
    )
    .join("; ");
  const maisFalhas =
    falhas.length > MAX_FALHAS_CITADAS
      ? ` (+${falhas.length - MAX_FALHAS_CITADAS})`
      : "";

  const sufixoPulados = pulados.length > 0 ? ` ${descreverPulados(pulados)}` : "";

  if (falhas.length > 0) {
    const mensagem =
      sincronizados > 0
        ? `Produto atualizado. ${sincronizados} anúncio(s) sincronizado(s); ${falhas.length} falhou(aram): ${resumoDasFalhas}${maisFalhas}.`
        : `Produto atualizado, mas ${falhas.length} anúncio(s) falhou(aram): ${resumoDasFalhas}${maisFalhas}.`;
    return { mensagem: `${mensagem}${sufixoPulados}`, tipo: "warning" };
  }

  // Sem falha nenhuma. Pulado ainda assim vira AVISO, e não sucesso: é o único
  // jeito de o lojista reparar que um canal ficou de fora.
  if (pulados.length > 0) {
    if (sincronizados > 0) {
      return {
        mensagem: `Produto atualizado e ${sincronizados} anúncio(s) sincronizado(s).${sufixoPulados}`,
        tipo: "warning",
      };
    }
    // Todos pulados: não faz sentido dizer "0 sincronizados" nem repetir a
    // contagem, porque a contagem É o total.
    const canais = canaisPausados(pulados);
    return {
      mensagem: canais
        ? `Produto atualizado, mas nenhum anúncio recebeu a alteração: integração pausada (${canais}).`
        : "Produto atualizado, mas nenhum anúncio recebeu a alteração.",
      tipo: "warning",
    };
  }

  return {
    mensagem: `Produto atualizado e ${sincronizados} anúncio(s) sincronizado(s).`,
    tipo: "success",
  };
}

/**
 * Linha "Compatibilidade" do card do anúncio ML, a partir do
 * `ProductListing.compatDiagnostics` que o read-back do ML grava.
 *
 * O diagnóstico existia desde agosto mas nenhuma tela o lia: a vendedora só
 * descobria no painel do ML que os veículos não tinham entrado. Aqui ele vira
 * uma frase — o que foi CONFIRMADO no ML, não o que foi enviado.
 *
 * Diagnóstico ausente (anúncio antigo, ou sem compatibilidade cadastrada) ⇒
 * `null`: a linha simplesmente não aparece, como antes.
 */

export type CompatSummaryTone = "ok" | "warning" | "muted";

export interface CompatSummary {
  tone: CompatSummaryTone;
  text: string;
}

type Unresolved = { brand?: unknown; model?: unknown; year?: unknown };

/** Mesmo valor de COMPAT_DIAGNOSTICS_VERSION (lib do servidor). */
const VERSAO_ATUAL = 2;

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

function exemplo(sample: unknown): string {
  if (!Array.isArray(sample) || sample.length === 0) return "";
  const nomes = (sample as Unresolved[])
    .slice(0, 2)
    .map((u) =>
      [u?.brand, u?.model, u?.year]
        .filter((p) => p !== null && p !== undefined && String(p).trim())
        .map(String)
        .join(" "),
    )
    .filter(Boolean);
  return nomes.length > 0 ? ` (ex.: ${nomes.join(", ")})` : "";
}

export function describeCompatDiagnostics(diag: unknown): CompatSummary | null {
  if (!diag || typeof diag !== "object" || Array.isArray(diag)) return null;
  const d = diag as Record<string, unknown>;

  if (typeof d.unsupportedDomain === "string" && d.unsupportedDomain) {
    return {
      tone: "warning",
      text: "O Mercado Livre não aceita compatibilidade de veículos nesta categoria.",
    };
  }

  const persisted = typeof d.persisted === "number" ? d.persisted : 0;
  const requested = typeof d.requested === "number" ? d.requested : 0;
  const unresolved = typeof d.unresolved === "number" ? d.unresolved : 0;
  const verified = d.verified === true;
  const truncated = Array.isArray(d.truncated) && d.truncated.length > 0;
  const positions =
    d.positions && typeof d.positions === "object"
      ? (d.positions as Record<string, unknown>)
      : null;

  // Gravado antes da correção da paginação (22/09/2026): o "não encontrado"
  // e o total vieram da busca que relia os mesmos 50 veículos — não afirmar
  // nada que ele diga sobre o catálogo.
  if (d.v !== VERSAO_ATUAL) {
    return persisted > 0
      ? {
          tone: "muted",
          text: `Compatibilidade no Mercado Livre: ${persisted} ${plural(persisted, "veículo", "veículos")} (conferida antes desta atualização).`,
        }
      : {
          tone: "muted",
          text: "Compatibilidade ainda não confirmada no Mercado Livre.",
        };
  }

  // "Nenhum veículo existe no catálogo do ML" só com prova: a busca resolveu
  // ZERO e nenhuma busca falhou. (`unresolved` conta veículo×ano; comparar
  // com `requested`, que conta veículos, afirmava isso com o Gol achado.)
  const resolvidos = typeof d.resolved === "number" ? d.resolved : null;
  const buscasFalhas = typeof d.lookupFailed === "number" ? d.lookupFailed : 0;
  const nadaNoCatalogo =
    persisted === 0 && requested > 0 && resolvidos === 0 && buscasFalhas === 0;
  if (nadaNoCatalogo && unresolved > 0) {
    return {
      tone: "warning",
      text: `Nenhum veículo foi encontrado no catálogo do Mercado Livre${exemplo(d.unresolvedSample)}.`,
    };
  }
  if (persisted === 0 && buscasFalhas > 0) {
    return {
      tone: "muted",
      text: "A busca de veículos no catálogo do Mercado Livre falhou; a compatibilidade não foi enviada.",
    };
  }

  if (!verified) {
    return {
      tone: "muted",
      text:
        persisted > 0
          ? `Compatibilidade enviada ao Mercado Livre: ${persisted} ${plural(persisted, "veículo", "veículos")}; o Mercado Livre não permitiu confirmar a gravação.`
          : "O envio da compatibilidade não foi confirmado pelo Mercado Livre.",
    };
  }

  if (persisted === 0) {
    return {
      tone: "warning",
      text:
        nadaNoCatalogo && unresolved > 0
          ? `Nenhum veículo foi encontrado no catálogo do Mercado Livre${exemplo(d.unresolvedSample)}.`
          : "O Mercado Livre não confirmou nenhum veículo.",
    };
  }

  const partes = [
    `Compatibilidade confirmada no Mercado Livre: ${persisted} ${plural(persisted, "veículo", "veículos")}`,
  ];
  if (unresolved > 0) {
    partes.push(
      `${unresolved} ${plural(unresolved, "não encontrado", "não encontrados")} no catálogo do ML${exemplo(d.unresolvedSample)}`,
    );
  }
  if (truncated) partes.push("catálogo lido só em parte");
  if (positions?.echo === "dropped") {
    partes.push("o ML descartou a posição (lado/eixo)");
  }
  return {
    tone: unresolved > 0 || truncated || positions?.echo === "dropped" ? "warning" : "ok",
    text: partes.join(" · ") + ".",
  };
}

/**
 * Monta o `<relatorioNFe>` mensal consolidado para envio ao contador.
 *
 * Container CUSTOMIZADO do Dexo — não é um leiaute oficial da SEFAZ. O que é
 * oficial é o `nfeProc` de cada nota, embutido VERBATIM sob `<notas><nota>`.
 *
 * REGRA CRÍTICA: o XML autorizado de cada nota é tratado como texto opaco —
 * apenas o BOM e a declaração `<?xml ... ?>` iniciais são removidos
 * (stripXmlDeclaration); nada é re-parseado/re-serializado, preservando a
 * assinatura digital se o contador validar o documento.
 *
 * Função pura (sem I/O): recebe as notas com o conteúdo do XML já lido.
 */

export interface RelatorioNota {
  numero: number | string;
  serie: number | string;
  chaveAcesso: string | null;
  status: string;
  dataEmissao: Date | null;
  dataAutorizacao: Date | null;
  protocoloAutorizacao: string | null;
  destinatarioNome: string;
  destinatarioDocumento: string;
  valorTotal: number;
  /** Conteúdo do XML autorizado (nfeProc); null quando ausente em disco. */
  xmlAutorizado: string | null;
  /**
   * "ENTRADA" | "SAIDA" (opcional). Só a ENTRADA é rotulada no resumo — a nota de
   * saída sai exatamente como antes.
   */
  tipoOperacao?: string | null;
  /** "DEVOLUCAO" é rotulada no resumo; as demais saem como antes. Opcional. */
  finalidade?: string | null;
}

export interface RelatorioMensalInput {
  emitente: { cnpj: string; razaoSocial: string };
  ano: number;
  mes: number;
  geradoEm: Date;
  notas: RelatorioNota[];
}

export function escapeXmlAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Remove o BOM e a declaração `<?xml ... ?>` do INÍCIO do documento, mantendo
 * todo o resto byte-a-byte. Regex ancorada e preguiçosa até o primeiro `?>`.
 */
export function stripXmlDeclaration(xml: string): string {
  let s = xml;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const m = s.match(/^\s*<\?xml[\s\S]*?\?>\s*/);
  return m ? s.slice(m[0].length) : s;
}

/**
 * Data/hora no padrão da NF-e: Brasília fixo -03:00 (sem horário de verão
 * desde 2019), independente do fuso do servidor — mesma convenção do builder
 * de XML da emissão (formatDhEmi).
 */
export function formatBrasiliaIso(d: Date): string {
  const shifted = new Date(d.getTime() - 3 * 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-` +
    `${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:` +
    `${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}-03:00`
  );
}

export function buildRelatorioMensalXml(input: RelatorioMensalInput): string {
  const { emitente, ano, mes, geradoEm, notas } = input;
  const mes2 = String(mes).padStart(2, "0");
  const valorTotal = notas.reduce(
    (acc, n) => acc + (Number(n.valorTotal) || 0),
    0,
  );
  // Entradas (devolução de venda, nota de entrada) ROTULADAS, sem mudar o `valorTotal`
  // de sempre (que soma entrada e saída): `valorEntradas`/`quantidadeEntradas` no resumo e
  // `tipoOperacao`/`finalidade` na linha da nota. Mês sem entrada nem devolução: o XML
  // sai byte a byte como antes.
  const entradas = notas.filter((n) => n.tipoOperacao === "ENTRADA");
  const valorEntradas = entradas.reduce((acc, n) => acc + (Number(n.valorTotal) || 0), 0);
  const rotuloResumo = entradas.length
    ? ` quantidadeEntradas="${entradas.length}" valorEntradas="${valorEntradas.toFixed(2)}"`
    : "";
  const rotuloNota = (n: RelatorioNota) =>
    (n.tipoOperacao === "ENTRADA" ? ` tipoOperacao="ENTRADA"` : "") +
    (n.finalidade === "DEVOLUCAO" ? ` finalidade="DEVOLUCAO"` : "");

  const dateAttr = (d: Date | null) => (d ? formatBrasiliaIso(d) : "");

  const linhas: string[] = [];
  linhas.push('<?xml version="1.0" encoding="UTF-8"?>');
  linhas.push(
    `<relatorioNFe versao="1.0" geradoEm="${escapeXmlAttr(formatBrasiliaIso(geradoEm))}">`,
  );
  linhas.push(
    `  <emitente cnpj="${escapeXmlAttr(emitente.cnpj)}" razaoSocial="${escapeXmlAttr(emitente.razaoSocial)}"/>`,
  );
  linhas.push(`  <competencia ano="${ano}" mes="${mes2}"/>`);

  if (notas.length === 0) {
    linhas.push('  <resumo quantidade="0" valorTotal="0.00"/>');
    linhas.push("  <notas/>");
  } else {
    linhas.push(
      `  <resumo quantidade="${notas.length}" valorTotal="${valorTotal.toFixed(2)}"${rotuloResumo}>`,
    );
    for (const n of notas) {
      linhas.push(
        `    <nota numero="${escapeXmlAttr(String(n.numero))}"` +
          ` serie="${escapeXmlAttr(String(n.serie))}"` +
          ` chaveAcesso="${escapeXmlAttr(n.chaveAcesso ?? "")}"` +
          ` status="${escapeXmlAttr(n.status)}"` +
          ` dataEmissao="${escapeXmlAttr(dateAttr(n.dataEmissao))}"` +
          ` dataAutorizacao="${escapeXmlAttr(dateAttr(n.dataAutorizacao))}"` +
          ` protocolo="${escapeXmlAttr(n.protocoloAutorizacao ?? "")}"` +
          ` destinatario="${escapeXmlAttr(n.destinatarioNome)}"` +
          ` documento="${escapeXmlAttr(n.destinatarioDocumento)}"` +
          ` valorTotal="${(Number(n.valorTotal) || 0).toFixed(2)}"${rotuloNota(n)}/>`,
      );
    }
    linhas.push("  </resumo>");
    linhas.push("  <notas>");
    for (const n of notas) {
      const idAttrs =
        `chaveAcesso="${escapeXmlAttr(n.chaveAcesso ?? "")}"` +
        ` numero="${escapeXmlAttr(String(n.numero))}"` +
        ` serie="${escapeXmlAttr(String(n.serie))}"`;
      if (n.xmlAutorizado) {
        linhas.push(
          `    <nota ${idAttrs}>${stripXmlDeclaration(n.xmlAutorizado)}</nota>`,
        );
      } else {
        linhas.push(`    <nota ${idAttrs} xmlIndisponivel="true"/>`);
      }
    }
    linhas.push("  </notas>");
  }

  linhas.push("</relatorioNFe>");
  return linhas.join("\n");
}

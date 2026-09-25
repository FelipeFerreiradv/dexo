/**
 * O que o diálogo "Enviar por e-mail" mostra depois da resposta de
 * POST /fiscal/nfe/:id/resend-email.
 *
 * `danfeOmitido: true` vem quando a nota está CANCELADA e o DANFE não pôde ser
 * marcado como cancelado: o e-mail sai só com o XML. Antes o diálogo mostrava
 * "E-mail enviado com sucesso!" e fechava sozinho — o operador achava que o DANFE
 * tinha ido. Sem a chave, o resultado é o de sempre.
 */
export type ResultadoEnvioEmail =
  | { tipo: "enviado" }
  | { tipo: "enviado-com-aviso"; texto: string }
  | { tipo: "erro"; texto: string };

export function resultadoEnvioEmail(ok: boolean, data: unknown): ResultadoEnvioEmail {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (!ok || !d.success) {
    return { tipo: "erro", texto: typeof d.error === "string" && d.error ? d.error : "Erro ao enviar e-mail" };
  }
  if (d.danfeOmitido === true) {
    return {
      tipo: "enviado-com-aviso",
      texto: typeof d.mensagem === "string" && d.mensagem ? d.mensagem : "E-mail enviado sem o DANFE.",
    };
  }
  return { tipo: "enviado" };
}

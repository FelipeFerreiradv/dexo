import type { NfeRespTec } from "./nfe-xml-builder-sefaz.service";

/**
 * Resolve os dados do Responsável Técnico (software house — NT 2018.005) a
 * partir do ambiente. O RT é o MESMO para todos os tenants (não vem de
 * CompanyFiscalConfig, que é por empresa), por isso mora no env.
 *
 * KILL-SWITCH: quando `NFE_RESP_TEC_CNPJ` está vazio/ausente, retorna undefined
 * e o grupo <infRespTec> NÃO é emitido — o XML fica byte-a-byte igual ao
 * anterior. CSRT (idCSRT/csrt) só entra quando `NFE_RESP_TEC_ID_CSRT` E
 * `NFE_RESP_TEC_CSRT` estão AMBOS preenchidos; caso contrário é omitido.
 *
 * Vive FORA do builder (que é puro, sem I/O): o SefazDirectProvider chama isto
 * e injeta o resultado em `opts.respTec`. A validação de completude
 * (xContato/email/fone) é feita no builder (buildInfRespTec) para falhar com
 * mensagem clara em vez de emitir um grupo pela metade.
 */
export function resolveRespTecFromEnv(
  env: Record<string, string | undefined> = process.env,
): NfeRespTec | undefined {
  const cnpj = (env.NFE_RESP_TEC_CNPJ ?? "").replace(/\D/g, "");
  if (!cnpj) return undefined; // kill-switch OFF → grupo omitido

  const idCSRT = (env.NFE_RESP_TEC_ID_CSRT ?? "").trim();
  const csrt = (env.NFE_RESP_TEC_CSRT ?? "").trim();

  return {
    cnpj,
    xContato: (env.NFE_RESP_TEC_XCONTATO ?? "").trim(),
    email: (env.NFE_RESP_TEC_EMAIL ?? "").trim(),
    fone: (env.NFE_RESP_TEC_FONE ?? "").trim(),
    // CSRT só quando AMBOS presentes.
    ...(idCSRT && csrt ? { idCSRT, csrt } : {}),
  };
}

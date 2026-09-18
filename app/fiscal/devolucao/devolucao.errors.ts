import { DEVOLUCAO_ERRO_HTTP, DEVOLUCAO_ERRO_MENSAGEM } from "./contrato";
import type { DevolucaoErroCodigo } from "./contrato";
import type { DevolucaoIssue } from "./tipos";
export class DevolucaoError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: DevolucaoErroCodigo, readonly issues?: DevolucaoIssue[]) {
    super(DEVOLUCAO_ERRO_MENSAGEM[code]); this.name="DevolucaoError";this.httpStatus=DEVOLUCAO_ERRO_HTTP[code];
  }
}

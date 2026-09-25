import { DEVOLUCAO_ERRO_HTTP, DEVOLUCAO_ERRO_MENSAGEM } from "./contrato";
import type { DevolucaoErroCodigo, ErroCampo } from "./contrato";
import type { DevolucaoIssue } from "./tipos";
/**
 * Erro da devolução com o MESMO envelope que a rota já serializa
 * (`respostaErroDevolucao`: `{ error, code, issues?, erros?, draftId? }`).
 * - `issues`: pendências por item (código de `DevolucaoIssueCode`, `ordem` = item como a tela mostra).
 * - `erros`: recusas de campo (`{campo, mensagem}`), iguais às do 400 do parser.
 * - `draftId`: o rascunho a que o erro se refere.
 * - `mensagem`: troca a frase padrão do código (quando a padrão diria outra coisa).
 */
export class DevolucaoError extends Error {
  readonly httpStatus: number;
  readonly erros?: ErroCampo[];
  readonly draftId?: string;
  constructor(readonly code: DevolucaoErroCodigo, readonly issues?: DevolucaoIssue[], extras?: { mensagem?: string; erros?: ErroCampo[]; draftId?: string }) {
    super(extras?.mensagem ?? DEVOLUCAO_ERRO_MENSAGEM[code]); this.name="DevolucaoError";this.httpStatus=DEVOLUCAO_ERRO_HTTP[code];
    if(extras?.erros)this.erros=extras.erros;
    if(extras?.draftId)this.draftId=extras.draftId;
  }
}

/**
 * Limites de UPLOAD da importação de bases legadas (painel Superadmin).
 *
 * Este módulo é a FONTE ÚNICA — dos números E das mensagens. Antes o "20MB"
 * estava escrito à mão em três lugares (o registro global do
 * @fastify/multipart, a mensagem de erro da rota e o rótulo do modal); mudar
 * um e esquecer os outros produz exatamente o pior sintoma possível: a UI
 * prometendo um limite e o servidor recusando com outro.
 *
 * ⚠️ SEM IMPORTS E SEM `process.env`, DE PROPÓSITO. É consumido pelo servidor
 * (rota Fastify) E por um client component do Next (`import-data-dialog.tsx`).
 * Um import de código de servidor arrastaria prisma/fs para o bundle do
 * browser; e uma variável de ambiente que não comece com `NEXT_PUBLIC_` chega
 * como `undefined` no cliente — os dois lados passariam a usar limites
 * diferentes em silêncio, que é justamente o bug que este arquivo existe para
 * impedir.
 *
 * POR QUE ESTES NÚMEROS
 * ---------------------
 * O maior export real recebido até hoje (fotos das peças do Emp595) tem
 * **36,1 MB** e 653.240 linhas. O limite antigo de 20 MB era o mesmo dos
 * uploads de FOTO DE PRODUTO — um teto pensado para imagem de celular, que
 * nunca teve nada a ver com planilha de migração.
 *
 * O teto por arquivo (100 MB) é ~2,8× o maior arquivo real. Ele NÃO é o guard
 * que protege a memória do processo: os bytes de um zip dizem pouco sobre o
 * custo de abrir a planilha. Quem protege a memória é o orçamento de CÉLULAS
 * em `app/usecases/import/parse/xlsx-reader.ts`, medido e documentado lá.
 *
 * ⚠️ LIMITE DE INFRAESTRUTURA (fora do código): o nginx da VPS está com
 * `client_max_body_size = 64M` GLOBAL (`/etc/nginx/nginx.conf`, verificado em
 * 2026-07-08 — ver `infra/hardening/RUNBOOK_VPS.md`). Uma request cujo corpo
 * TOTAL passe de 64 MB é cortada pelo nginx com 413 ANTES de chegar ao
 * Fastify — e, como o 413 do nginx não leva header de CORS, o browser mostra
 * um erro opaco em vez da mensagem daqui. Para usar a folga entre 64 MB e o
 * `IMPORT_MAX_TOTAL_BYTES` abaixo é preciso o passo manual do runbook.
 * Enquanto isso, o caso real (36 MB + 4 planilhas pequenas ≈ 42 MB) passa.
 */

/** Teto por arquivo enviado na importação. */
export const IMPORT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Teto do somatório dos arquivos de UMA request. Existe porque o limite por
 * arquivo sozinho não impede N arquivos grandes: o `readMultipart` mantém
 * todos os buffers vivos ao mesmo tempo (o motor precisa deles para o hash da
 * prévia e para o parse).
 */
export const IMPORT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/**
 * Quantidade máxima de arquivos por request. O pacote mais cheio hoje (IBR
 * Soft) tem 7 planilhas; 12 dá folga sem virar vetor de abuso.
 */
export const IMPORT_MAX_FILES = 12;

/** Tamanho legível em pt-BR ("36,1 MB"). Usado nas mensagens dos dois lados. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) {
    return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("pt-BR")} KB`;
  }
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

/* ------------------------- Mensagens de recusa -------------------------- */
/* Constantes (e não literais espalhados) para que a mensagem que o servidor  */
/* devolve seja LITERALMENTE a mesma que o modal mostra antes de enviar.      */

export const IMPORT_FILE_TOO_LARGE_MESSAGE =
  `Arquivo muito grande — o tamanho máximo permitido é ${formatBytes(IMPORT_MAX_FILE_BYTES)} por arquivo.`;

export const IMPORT_TOO_MANY_FILES_MESSAGE =
  `Arquivos demais — envie no máximo ${IMPORT_MAX_FILES} arquivos por importação.`;

export const IMPORT_TOTAL_TOO_LARGE_MESSAGE =
  `Os arquivos somam mais que o máximo de ${formatBytes(IMPORT_MAX_TOTAL_BYTES)} por importação. Envie a migração em partes.`;

/**
 * Valida a seleção INTEIRA de arquivos. Só o cliente consegue chamar assim —
 * ele conhece todos os tamanhos antes de enviar qualquer byte; o servidor
 * descobre um arquivo de cada vez e checa incrementalmente com as mesmas
 * constantes. Devolve a mensagem de recusa, ou `null` se pode enviar.
 */
export function checkImportFiles(
  files: Array<{ name: string; size: number }>,
): string | null {
  if (files.length === 0) return null;
  if (files.length > IMPORT_MAX_FILES) {
    return `Você anexou ${files.length} arquivos. ${IMPORT_TOO_MANY_FILES_MESSAGE}`;
  }
  const tooBig = files.find((f) => f.size > IMPORT_MAX_FILE_BYTES);
  if (tooBig) {
    return `"${tooBig.name}" tem ${formatBytes(tooBig.size)}. ${IMPORT_FILE_TOO_LARGE_MESSAGE}`;
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > IMPORT_MAX_TOTAL_BYTES) {
    return `Os arquivos somam ${formatBytes(total)}. ${IMPORT_TOTAL_TOO_LARGE_MESSAGE}`;
  }
  return null;
}

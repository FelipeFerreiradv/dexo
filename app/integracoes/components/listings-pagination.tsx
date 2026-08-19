"use client";

import { AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Rodapé das abas "Anúncios" dos cinco canais.
 *
 * Existe como componente único porque as cinco abas são quase cópias uma da
 * outra: cinco rodapés independentes iriam divergir na primeira correção que
 * alguém fizesse em um só. Não mexe na estrutura das abas — entra no lugar do
 * rodapé que já existia, que mostrava `listings.length`.
 *
 * ⚠️ A contagem passa a ser o TOTAL, não o tamanho da página. Com teto de 50 e
 * uma conta de 36 mil anúncios, dizer "50 vínculos encontrados" seria pior que
 * o número antigo: o operador concluiria que perdeu anúncios.
 */
export interface ListingsPaginationProps {
  /** Quantos vieram nesta página (para o "Mostrando N de T"). */
  mostrando: number;
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Trava os botões enquanto a página nova não chega. */
  carregando?: boolean;
}

export function ListingsPagination({
  mostrando,
  total,
  page,
  totalPages,
  onPageChange,
  carregando = false,
}: ListingsPaginationProps) {
  const temPaginas = totalPages > 1;

  return (
    <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-1">
        <AlertCircle className="h-4 w-4" />
        <span>
          {temPaginas ? (
            <>
              Mostrando {mostrando} de {total}{" "}
              {total === 1 ? "vínculo" : "vínculos"}
            </>
          ) : (
            <>
              {total} {total === 1 ? "vínculo encontrado" : "vínculos encontrados"}
            </>
          )}
        </span>
      </div>

      {temPaginas && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={carregando || page <= 1}
          >
            <ChevronLeft className="size-4" />
            Anterior
          </Button>
          <span className="whitespace-nowrap text-sm">
            Página {page} de {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={carregando || page >= totalPages}
          >
            Próximo
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

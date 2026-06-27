import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton só do MIOLO da visão Catálogo (grade de cards), usado durante o
 * bootstrap da lista. Espelha `app/pedidos/components/orders-gallery-skeleton.tsx`.
 * A visão Lista continua usando o `ProductSkeleton` existente.
 */
export function ProductsGallerySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col rounded-2xl border border-border/60 bg-card/80 p-3"
        >
          <Skeleton className="aspect-[4/3] w-full rounded-xl" />
          <div className="mt-3 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex gap-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

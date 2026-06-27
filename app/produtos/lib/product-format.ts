// Helpers de formatação compartilhados pelas visões de Produtos (Lista + Catálogo).
// Extraídos 1:1 de `products-list.tsx` (eram closures dentro do componente), sem
// mudança de comportamento.

export const formatPrice = (price: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(price);

export const formatDate = (dateString: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(dateString));

export const getStockBadgeVariant = (stock: number) => {
  if (stock === 0) return "destructive";
  if (stock <= 10) return "warning";
  return "success";
};

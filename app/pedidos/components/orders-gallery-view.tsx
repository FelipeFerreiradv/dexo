"use client";

import type { Order } from "@/app/interfaces/order.interface";
import { OrderCard } from "./order-card";

interface OrdersGalleryViewProps {
  orders: Order[];
  onView: (order: Order) => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}

/** Vitrine de pedidos: grade responsiva de `OrderCard` (1 → 4 colunas). */
export function OrdersGalleryView({
  orders,
  onView,
  selectable,
  selectedIds,
  onToggleSelect,
}: OrdersGalleryViewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4">
      {orders.map((order) => (
        <OrderCard
          key={order.id}
          order={order}
          onView={onView}
          selectable={selectable}
          selected={!!selectedIds?.has(order.id)}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Renderiza a pilha de toasts num portal para `document.body`, escapando de
 * qualquer stacking context da página. Combinado com `z-[100]` nos toasts,
 * garante que eles apareçam acima dos modais (Dialog/Sheet do Radix, z-50).
 *
 * Mudança puramente de apresentação: não altera mensagens, tipos, cores,
 * posição nem tempo dos toasts — só onde o container é montado e o z-index.
 */
export function ToastViewport({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    className ? <div className={className}>{children}</div> : <>{children}</>,
    document.body,
  );
}

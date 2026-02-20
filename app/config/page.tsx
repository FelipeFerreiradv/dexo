"use client";

import { useState } from "react";
import ConfigModal from "@/components/config-modal";

export default function ConfigPage() {
  // Quando acessar /config, abrimos o modal por padrão
  const [open, setOpen] = useState(true);

  return (
    <div>
      <ConfigModal open={open} onOpenChange={(v) => setOpen(v)} />
    </div>
  );
}

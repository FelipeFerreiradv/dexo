import { Platform } from "@prisma/client";

// Kill-switch de runtime das integrações OLX/Facebook — padrão *_DISABLED do
// projeto (LOCATION_FLAT_COUNTS_DISABLED, ORDER_CANCEL_RESTORE_DISABLED, ...).
//
// Diferente das flags NEXT_PUBLIC_*_INTEGRATION_ENABLED, que são build-time e só
// escondem a UI: as rotas /marketplace/{olx,facebook}/*, a publicação e o
// espelhamento de status continuam ativos mesmo com a flag de UI desligada.
// Estas chaves param TUDO em runtime (=1), sem rebuild. Lidas a cada chamada.

export function isOlxDisabled(): boolean {
  return process.env.OLX_INTEGRATION_DISABLED === "1";
}

export function isFacebookDisabled(): boolean {
  return process.env.FACEBOOK_INTEGRATION_DISABLED === "1";
}

// true = plataforma desligada por kill-switch (não deve publicar nem sincronizar).
export function isPlatformDisabled(platform: Platform | string): boolean {
  if (platform === "OLX") return isOlxDisabled();
  if (platform === "FACEBOOK") return isFacebookDisabled();
  return false;
}

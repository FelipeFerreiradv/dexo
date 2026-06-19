import { NextResponse } from "next/server";

// SEMPRE dinâmico e sem cache: o valor precisa refletir o build do servidor
// que está rodando AGORA (não pode ser cacheado em build nem em CDN).
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Público, sem auth e sem PII — devolve apenas o build id embutido pelo
// next.config (NEXT_PUBLIC_BUILD_ID). Um cliente que ainda roda um bundle
// antigo compara este valor com o id embutido no próprio bundle: se diferem,
// saiu build novo => o UpdateNotifier oferece o reload.
export async function GET() {
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_BUILD_ID ?? "" },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    },
  );
}

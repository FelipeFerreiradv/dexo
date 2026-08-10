# Sobe a API (Fastify) para TESTE LOCAL de OLX/Facebook.
#
# POR QUE ESTE SCRIPT EXISTE:
# o `.env` deste projeto aponta para o banco de PRODUÇÃO (Supabase São Paulo) e
# `npm run api` sobe 7 workers de fundo que ESCREVEM no banco e chamam as APIs
# reais dos marketplaces (republicam anúncio, empurram estoque, varrem status).
# Rodar `npm run api` cru na sua máquina mexeria em produção.
#
# `dotenv` NÃO sobrescreve variável já definida no processo, então tudo o que é
# setado aqui vence o `.env` — sem editar nenhum arquivo seu.
#
# USO:
#   .\scripts\dev-local\api.ps1              # modo SEGURO (padrão)
#   .\scripts\dev-local\api.ps1 -Publicar    # libera chamadas reais a OLX/Meta

param(
  # Sem esta flag, OLX e Facebook ficam desligados por kill-switch de runtime:
  # a UI aparece inteira e nenhuma chamada sai para fora.
  [switch]$Publicar
)

$ErrorActionPreference = "Stop"

# ─── TRAVA MESTRA ─────────────────────────────────────────────────────────────
# Nenhum worker de fundo sobe. É o que impede a máquina local de empurrar
# estoque e republicar anúncio em produção. NÃO REMOVA para testar a UI.
$env:BACKGROUND_WORKERS_DISABLED = "1"

# Reforço: mesmo que algum caminho tente subir, estes ficam explicitamente off.
$env:LISTING_STATUS_SYNC_DISABLED     = "1"
$env:ORDER_INGESTION_RECONCILER_DISABLED = "1"
$env:FACEBOOK_AUTODETECT_ENABLED      = "0"

if ($Publicar) {
  Remove-Item Env:OLX_INTEGRATION_DISABLED      -ErrorAction SilentlyContinue
  Remove-Item Env:FACEBOOK_INTEGRATION_DISABLED -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "  !!  MODO PUBLICACAO  !!" -ForegroundColor Red
  Write-Host "  Publicar/editar/pausar vai chamar a API REAL da OLX e da Meta." -ForegroundColor Red
  Write-Host "  Anuncio criado aqui e anuncio de verdade. Use conta piloto." -ForegroundColor Red
  Write-Host ""
} else {
  $env:OLX_INTEGRATION_DISABLED      = "1"
  $env:FACEBOOK_INTEGRATION_DISABLED = "1"
  Write-Host ""
  Write-Host "  Modo SEGURO: UI completa, ZERO chamada externa." -ForegroundColor Green
  Write-Host "  Para publicar de verdade: .\scripts\dev-local\api.ps1 -Publicar" -ForegroundColor DarkGray
  Write-Host ""
}

Write-Host "  workers de fundo: DESLIGADOS (BACKGROUND_WORKERS_DISABLED=1)" -ForegroundColor DarkGray
Write-Host "  API em http://localhost:3333" -ForegroundColor Cyan
Write-Host ""

npm run api

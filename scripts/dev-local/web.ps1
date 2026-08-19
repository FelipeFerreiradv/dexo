# Sobe o front (Next dev) com as abas de OLX e Facebook VISÍVEIS.
#
# As flags NEXT_PUBLIC_* são inlinadas pelo Next no momento do build/dev, então
# precisam existir ANTES de o servidor subir — não adianta setar depois.
# Sem elas, /integracoes/olx e /integracoes/facebook respondem 404 e os toggles
# das duas plataformas não aparecem em nenhum modal.
#
# USO:
#   .\scripts\dev-local\web.ps1

$ErrorActionPreference = "Stop"

$env:NEXT_PUBLIC_OLX_INTEGRATION_ENABLED      = "true"
$env:NEXT_PUBLIC_FACEBOOK_INTEGRATION_ENABLED = "true"

# O front fala com a API LOCAL, nas duas pontas:
#   - NEXT_PUBLIC_API_URL → usado no browser
#   - API_URL             → usado no server-side, e tem PRIORIDADE (lib/api.ts:12)
# Fixar as duas é obrigatório: se o seu `.env` tiver API_URL apontando para a
# VPS, as rotas server-side do Next chamariam a API de PRODUÇÃO enquanto o
# browser chamaria a local — e você testaria metade de cada ambiente.
$env:NEXT_PUBLIC_API_URL = "http://localhost:3333"
$env:API_URL             = "http://localhost:3333"

Write-Host ""
Write-Host "  OLX e Facebook: VISIVEIS na UI" -ForegroundColor Green
Write-Host "  API esperada em $($env:NEXT_PUBLIC_API_URL)" -ForegroundColor DarkGray
Write-Host "  Front em http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Suba a API no OUTRO terminal ANTES:  .\scripts\dev-local\api.ps1" -ForegroundColor Yellow
Write-Host ""

npm run dev

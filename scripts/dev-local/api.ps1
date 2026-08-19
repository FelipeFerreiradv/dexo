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
  [switch]$Publicar,

  # Faz o OAuth voltar para o SEU front em vez do endereço de produção.
  # Só funciona onde a plataforma aceita o endereço:
  #   - Facebook: sim, DEPOIS de você cadastrar
  #     http://localhost:3000/integracoes/facebook/callback em
  #     "Login do Facebook -> Configuracoes -> URIs de redirecionamento validos".
  #   - OLX: NÃO. Testado em 12/08/2026 — ela joga para oops.olx.com.br depois do
  #     login. O endereço da OLX é registrado por e-mail no suporte e não aceita
  #     substituto. Para a OLX o caminho é o finalizar-conexao.ps1 (veja abaixo).
  [switch]$CallbackLocal,

  # Onde o seu front local está ouvindo (o web.ps1 sobe em 3000).
  [string]$FrontUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

# ─── OAUTH: PARA ONDE O NAVEGADOR VOLTA ───────────────────────────────────────
# O `.env` traz OLX_REDIRECT_URI/FACEBOOK_REDIRECT_URI apontando para
# https://usedexo.com.br/integracoes/<canal>/callback — o endereço REGISTRADO na
# OLX e no app da Meta. É o único que a OLX aceita, então é o padrão aqui também.
#
# Em teste local isso tem um efeito colateral conhecido: a produção ainda roda a
# `main`, que não tem as páginas de OLX/Facebook, então depois do login o popup
# cai num 404. O `code` está vivo na barra de endereço dessa janela e o `state`
# mora na MEMÓRIA desta API — quem fecha a conexão é o finalizar-conexao.ps1:
#
#   1. copie a URL inteira da janela do 404
#   2. .\scripts\dev-local\finalizar-conexao.ps1
#
# Isso deixa de ser necessário no dia em que a branch estiver em produção.
if ($CallbackLocal) {
  $env:OLX_REDIRECT_URI      = "$FrontUrl/integracoes/olx/callback"
  $env:FACEBOOK_REDIRECT_URI = "$FrontUrl/integracoes/facebook/callback"
}

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

if ($CallbackLocal) {
  Write-Host "  retorno do OAuth: $FrontUrl/integracoes/<canal>/callback" -ForegroundColor Yellow
  Write-Host "  a OLX RECUSA esse endereco (cai em oops.olx.com.br). Serve so p/ Facebook," -ForegroundColor DarkGray
  Write-Host "  e so se voce cadastrou a URI no app da Meta." -ForegroundColor DarkGray
} else {
  Write-Host "  retorno do OAuth: producao (endereco registrado na OLX/Meta)" -ForegroundColor DarkGray
  Write-Host "  depois do login o popup cai num 404 em usedexo.com.br. E esperado:" -ForegroundColor DarkGray
  Write-Host "  copie a URL inteira de la e rode  .\scripts\dev-local\finalizar-conexao.ps1" -ForegroundColor Cyan
}
Write-Host ""

npm run api

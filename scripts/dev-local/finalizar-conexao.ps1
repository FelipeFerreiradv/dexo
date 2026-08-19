# Fecha uma conexão OAuth de OLX/Facebook a partir da URL de retorno.
#
# QUANDO USAR:
# é o passo normal de teste local. A OLX e a Meta só devolvem o navegador para o
# endereço REGISTRADO nelas — https://usedexo.com.br/integracoes/<canal>/callback
# — e a produção ainda roda a `main`, sem as páginas de OLX/Facebook. Depois do
# login o popup cai num 404 ali. O `code` está vivo na barra de endereço dessa
# janela; este script entrega ele para a SUA API local, que é quem guarda o
# `state` e sabe de quem é a conta.
#
# (Apontar o retorno para localhost não resolve: a OLX recusa e joga para
# oops.olx.com.br. Testado em 12/08/2026.)
#
# USO — copie a URL da janela do 404 (Ctrl+L, Ctrl+C) e rode:
#   .\scripts\dev-local\finalizar-conexao.ps1
#
# Ou passe na mão:
#   .\scripts\dev-local\finalizar-conexao.ps1 -Url "<cole a URL aqui>"
#
# PRAZO: o `code` da OLX vale 10 min e o `state` é de uso único, guardado na
# MEMÓRIA da API. Se você reiniciou o terminal da API (ou o `tsx watch`
# recarregou por causa de uma edição em .ts), o `state` se perdeu — refaça o
# "Conectar" do zero.

param(
  # Sem isto, o script lê a URL da area de transferencia.
  [string]$Url,

  [string]$ApiUrl = "http://localhost:3333"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Web

if (-not $Url) {
  $Url = (Get-Clipboard -Raw)
  if ($Url) { $Url = $Url.Trim() }
  if (-not $Url) {
    Write-Host ""
    Write-Host "  A area de transferencia esta vazia." -ForegroundColor Red
    Write-Host "  Clique na barra de endereco da janela do 404 (Ctrl+L), copie (Ctrl+C) e rode de novo." -ForegroundColor DarkGray
    Write-Host ""
    exit 1
  }
  Write-Host ""
  Write-Host "  URL lida da area de transferencia." -ForegroundColor DarkGray
}

$parsed = $null
try {
  $parsed = [uri]$Url
} catch {
  Write-Host "  URL invalida. Cole a URL inteira, com http/https." -ForegroundColor Red
  exit 1
}

if (-not $parsed.IsAbsoluteUri) {
  Write-Host ""
  Write-Host "  Isso nao parece uma URL: $Url" -ForegroundColor Red
  Write-Host "  Copie a barra de endereco INTEIRA da janela que deu 404." -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

$query = [System.Web.HttpUtility]::ParseQueryString($parsed.Query)
$code  = $query["code"]
$state = $query["state"]

# A OLX/Meta podem devolver o erro na propria URL, em vez de code/state.
$erro = $query["error"]
if ($erro) {
  $descricao = $query["error_description"]
  Write-Host ""
  Write-Host "  A plataforma recusou a autorizacao: $erro" -ForegroundColor Red
  if ($descricao) { Write-Host "  $descricao" -ForegroundColor Red }
  Write-Host ""
  exit 1
}

if (-not $code -or -not $state) {
  Write-Host ""
  Write-Host "  Nao achei 'code' e 'state' nessa URL." -ForegroundColor Red
  Write-Host "  Copie a barra de endereco INTEIRA da janela que deu 404." -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

# Canal pelo caminho da URL: /integracoes/<canal>/callback (front) ou
# /marketplace/<canal>/callback (backend). Os dois formatos servem.
$caminho = $parsed.AbsolutePath.ToLowerInvariant()
$canal = $null
if ($caminho -match "/olx/")      { $canal = "olx" }
if ($caminho -match "/facebook/") { $canal = "facebook" }

if (-not $canal) {
  Write-Host ""
  Write-Host "  Nao consegui dizer se essa URL e de OLX ou de Facebook." -ForegroundColor Red
  Write-Host "  Caminho lido: $caminho" -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

$nome = "OLX"
if ($canal -eq "facebook") { $nome = "Facebook" }

$destino = "$ApiUrl/marketplace/$canal/callback?code=$([uri]::EscapeDataString($code))&state=$([uri]::EscapeDataString($state))"

Write-Host ""
Write-Host "  Finalizando a conexao com o $nome pela API local..." -ForegroundColor Cyan
Write-Host "  $ApiUrl/marketplace/$canal/callback" -ForegroundColor DarkGray
Write-Host ""

try {
  # Accept explicito: com text/html a rota RESPONDE COM REDIRECT para o front,
  # em vez do JSON que queremos ler aqui.
  $resposta = Invoke-WebRequest -Uri $destino -Method Get -Headers @{ Accept = "application/json" } -UseBasicParsing
  $corpo = $resposta.Content | ConvertFrom-Json

  Write-Host "  Conta do $nome conectada." -ForegroundColor Green
  if ($corpo.account) {
    Write-Host "  id: $($corpo.account.id)   status: $($corpo.account.status)" -ForegroundColor DarkGray
  }
  Write-Host ""
  Write-Host "  Recarregue http://localhost:3000/integracoes/$canal para ver a conta." -ForegroundColor Cyan
  Write-Host ""
} catch {
  $mensagem = $_.Exception.Message

  # No PS 5.1 o corpo da resposta de erro chega em ErrorDetails.Message; o
  # stream da Response ja veio consumido. Ler o stream fica so como reserva.
  $bruto = $null
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    $bruto = $_.ErrorDetails.Message
  } elseif ($_.Exception.Response) {
    try {
      $leitor = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $bruto = $leitor.ReadToEnd()
      $leitor.Close()
    } catch {
      # sem corpo legivel: fica a mensagem original da excecao
    }
  }

  if ($bruto) {
    try {
      $json = $bruto | ConvertFrom-Json
      if ($json.message) { $mensagem = $json.message }
      elseif ($json.error) { $mensagem = $json.error }
    } catch {
      $mensagem = $bruto
    }
  }

  Write-Host "  Nao deu para fechar a conexao." -ForegroundColor Red
  Write-Host "  $mensagem" -ForegroundColor Red
  Write-Host ""
  if ($mensagem -match "State") {
    Write-Host "  'State invalido ou expirado' quase sempre e um destes tres:" -ForegroundColor Yellow
    Write-Host "   - passaram mais de 10 min desde o clique em Conectar;" -ForegroundColor DarkGray
    Write-Host "   - a API reiniciou (o state vive na memoria dela);" -ForegroundColor DarkGray
    Write-Host "   - esta URL ja foi usada uma vez (o state e de uso unico)." -ForegroundColor DarkGray
    Write-Host "  Em qualquer um deles: clique em Conectar de novo e refaca o login." -ForegroundColor Yellow
    Write-Host ""
  }
  exit 1
}

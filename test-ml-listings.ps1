# Script PowerShell para testar criação de anúncios no Mercado Livre
# Execute este script no terminal PowerShell para testar os anúncios

param(
    [string]$UserEmail = "fefelbf@gmail.com",
    [string]$ProductId = "cml8ydwhb0000vs2w7nruq0va"
)

Write-Host "=== TESTE DE CRIAÇÃO DE ANÚNCIOS NO MERCADO LIVRE ===" -ForegroundColor Cyan
Write-Host "Email: $UserEmail" -ForegroundColor Yellow
Write-Host "ProductId: $ProductId" -ForegroundColor Yellow
Write-Host ""

# Teste 1: Verificar status da conta ML
Write-Host "1. Verificando status da conta Mercado Livre..." -ForegroundColor Green
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3333/marketplace/ml/status" -Headers @{"email"=$UserEmail} -Method GET -UseBasicParsing
    $status = $response.Content | ConvertFrom-Json
    Write-Host "✅ Status: $($status.message)" -ForegroundColor Green
    if ($status.connected -eq $true) {
        Write-Host "✅ Conta conectada com sucesso!" -ForegroundColor Green
    } else {
        Write-Host "❌ Conta não conectada" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "❌ Erro ao verificar status: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Teste 2: Criar anúncio simples
Write-Host "2. Criando anúncio simples..." -ForegroundColor Green
try {
    $body = @{
        productId = $ProductId
    } | ConvertTo-Json

    $response = Invoke-WebRequest -Uri "http://localhost:3333/listings/ml" -Headers @{"email"=$UserEmail; "Content-Type"="application/json"} -Method POST -Body $body -UseBasicParsing
    $result = $response.Content | ConvertFrom-Json

    if ($result.success -eq $true) {
        Write-Host "✅ Anúncio criado com sucesso!" -ForegroundColor Green
        Write-Host "   ID do anúncio: $($result.listingId)" -ForegroundColor Cyan
        Write-Host "   ID externo (ML): $($result.externalListingId)" -ForegroundColor Cyan
    } else {
        Write-Host "❌ Falha ao criar anúncio: $($result.error)" -ForegroundColor Red
    }
} catch {
    Write-Host "❌ Erro ao criar anúncio: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $errorContent = $_.Exception.Response.GetResponseStream() | %{ New-Object System.IO.StreamReader($_) } | %{ $_.ReadToEnd() }
        Write-Host "   Detalhes: $errorContent" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=== TESTE CONCLUÍDO ===" -ForegroundColor Cyan
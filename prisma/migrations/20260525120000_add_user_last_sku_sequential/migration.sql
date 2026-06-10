-- Adiciona contador de SKU sequencial por usuario. Incrementado apenas
-- em createProduct (fluxo do modal Novo Produto). Importacoes de estoque
-- escrevem direto em Product e NAO tocam aqui, isolando a sequencia
-- humana de codigos externos vindos de planilha.

ALTER TABLE "User" ADD COLUMN "lastSkuSequential" INTEGER;

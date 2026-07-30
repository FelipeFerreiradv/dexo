-- Indice de EXPRESSAO para o filtro de periodo por COALESCE("soldAt","createdAt").
--
-- Motivo: o Dashboard e o relatorio filtram e agrupam por
-- COALESCE(o."soldAt", o."createdAt"). Em Postgres, envolver uma coluna indexada
-- numa funcao torna o predicado NAO-SARGAVEL: o planner deixa de usar
-- "Order_marketplaceAccountId_createdAt_idx" e passa a scan + filtro. Com 6.390
-- linhas o custo hoje e baixo, mas ele cresce com a tabela, e o Dashboard e a
-- primeira tela depois do login.
--
-- O indice abaixo casa exatamente com a expressao usada nas queries. Nao ha
-- dependencia de ordem com deploy: o codigo funciona sem ele, so mais lento.
-- Prisma nao expressa indice de expressao no schema, entao ele vive apenas aqui
-- (documentado tambem em prisma/schema.prisma, no model Order).
--
-- Idempotente: pode rodar duas vezes.
CREATE INDEX IF NOT EXISTS "Order_mktAcc_periodo_idx"
  ON "Order"("marketplaceAccountId", (COALESCE("soldAt", "createdAt")));

-- Serve as queries do Dashboard que filtram por periodo sem escopo de conta na
-- clausula (o escopo vem do JOIN com MarketplaceAccount por userId).
CREATE INDEX IF NOT EXISTS "Order_periodo_idx"
  ON "Order"((COALESCE("soldAt", "createdAt")));

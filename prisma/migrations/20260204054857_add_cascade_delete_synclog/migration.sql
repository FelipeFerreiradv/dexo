-- DropForeignKey
ALTER TABLE "SyncLog" DROP CONSTRAINT "SyncLog_marketplaceAccountId_fkey";

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_marketplaceAccountId_fkey" FOREIGN KEY ("marketplaceAccountId") REFERENCES "MarketplaceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

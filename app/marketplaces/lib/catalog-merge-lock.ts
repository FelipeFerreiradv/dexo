/**
 * Global PostgreSQL advisory gate shared by catalog merges and creation of
 * durable jobs that keep Product IDs outside a foreign key.
 */
export const CATALOG_PRODUCT_MERGE_LOCK_KEY = "catalog_product_merge:v1";

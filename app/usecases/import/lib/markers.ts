/**
 * Markers de idempotência gravados em `notes` (Customer/Scrap) e em
 * `informacoesComplementares` (NF-e). O motor grava markers próprios
 * ("Import Dexo · …") e RECONHECE também os legados dos scripts de migração
 * ("Legado <TENANT> · …") para nunca duplicar dados de tenants que já
 * passaram por migração manual via CLI.
 */

/** Marker novo (motor de importação). */
export function importCustomerMarker(cod: string): string {
  return `Import Dexo · cliente #${cod}`;
}

export function importVehicleMarker(cod: string): string {
  return `Import Dexo · veículo #${cod}`;
}

export function importScrapWdMarker(wdId: string): string {
  return `Import Dexo · sucata #${wdId}`;
}

export function importNfeMarker(tag: string): string {
  return `Import Dexo · NF-e histórica (${tag})`;
}

/** Conta importada: marker por linha (hash curto) na description. */
export function importFinanceMarker(lineHash: string): string {
  return `[import ${lineHash}]`;
}

/**
 * Extrai o código legado de um marker de CLIENTE — cobre o formato novo
 * ("Import Dexo · cliente #12") e o legado dos scripts
 * ("Legado 704 · cliente #12"). Aceita código numérico (Vaapt), GUID
 * (WebDesmonte) e o pseudo-código "nd-<hash>" gerado para clientes sem
 * código na origem.
 */
export function parseCustomerMarker(notes: string | null | undefined): string | null {
  const m = notes?.match(/cliente #([0-9a-zA-Z-]+)/);
  return m ? m[1] : null;
}

/** Idem para VEÍCULO Vaapt ("veículo #<cod>"). */
export function parseVehicleMarker(notes: string | null | undefined): string | null {
  const m = notes?.match(/veículo #(\d+)/);
  return m ? m[1] : null;
}

/** Idem para SUCATA WebDesmonte ("sucata #<wdId>" — wdId é GUID ou número). */
export function parseScrapWdMarker(notes: string | null | undefined): string | null {
  const m = notes?.match(/sucata #([0-9a-fA-F-]+)/);
  return m ? m[1] : null;
}

/** Extrai o hash de linha de uma conta importada ("[import ab12cd34]"). */
export function parseFinanceMarker(text: string | null | undefined): string | null {
  const m = text?.match(/\[import ([0-9a-f]{8})\]/);
  return m ? m[1] : null;
}

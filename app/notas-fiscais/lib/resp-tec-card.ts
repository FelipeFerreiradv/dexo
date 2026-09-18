import type { AvisoRespTec, RespTecModo } from "../../fiscal/domain/resp-tec";
export interface RespTecPublico {
  modo: string; cnpj: string | null; xContato: string | null; email: string | null; fone: string | null;
  idCsrt: string | null; csrtConfigurado: boolean; modosPermitidos: RespTecModo[]; avisos: AvisoRespTec[];
}
export function respTecEndpoint(companyId?: string | null): string {
  return companyId ? `/fiscal/companies/${encodeURIComponent(companyId)}/resp-tec` : "/fiscal/config/resp-tec";
}
export function respTecBody(row: RespTecPublico, token: string, removerCsrt: boolean) {
  return {modo:row.modo,cnpj:row.cnpj,xContato:row.xContato,email:row.email,fone:row.fone,idCsrt:row.idCsrt,
    ...(token.trim() ? {csrtToken:token.trim()} : {}),removerCsrt};
}

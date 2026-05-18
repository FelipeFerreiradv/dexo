export interface Unidade {
  id: string;
  userId: string;
  name: string;
  code: string | null;
  notes: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UnidadeCreate {
  userId: string;
  name: string;
  code?: string | null;
  notes?: string | null;
  active?: boolean;
}

export type UnidadeUpdate = Partial<Omit<UnidadeCreate, "userId">>;

export interface UnidadeListResult {
  unidades: Unidade[];
  total: number;
}

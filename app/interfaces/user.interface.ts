export interface User {
  id: string;
  email: string;
  password: string;
  name?: string | null;
  defaultProductDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCreate {
  email: string;
  name?: string;
  password: string;
  defaultProductDescription?: string;
}

export interface UserUpdate {
  name?: string;
  defaultProductDescription?: string;
}

export interface UserRepository {
  create(data: UserCreate): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  update(id: string, data: UserUpdate): Promise<User>;
}

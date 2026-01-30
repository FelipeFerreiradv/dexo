export interface User {
  id: string;
  email: string;
  password: string;
  name?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCreate {
  email: string;
  name?: string;
  password: string;
}

export interface UserRepository {
  create(data: UserCreate): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
}

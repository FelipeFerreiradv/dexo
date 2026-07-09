import {
  User,
  UserCreate,
  UserRepository,
  UserUpdate,
} from "../interfaces/user.interface";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { verifyPassword } from "../lib/password";

export class UserUseCase {
  private userRepository: UserRepository;
  constructor() {
    this.userRepository = new UserRepositoryPrisma();
  }

  async create({
    name,
    email,
    password,
    defaultProductDescription,
    avatarUrl,
    parentUserId,
    role,
    defaultCostPrice,
    defaultStock,
  }: UserCreate): Promise<User> {
    const verifyUserExists = await this.userRepository.findByEmail(email);
    if (verifyUserExists) {
      throw new Error("User already exists");
    }
    // parentUserId/role/defaults são opcionais e aditivos: o repositório faz
    // spread condicional (`!== undefined`), então quando ausentes (POST /users e
    // POST /me/team/collaborators atuais) o comportamento é IDÊNTICO ao anterior
    // — role cai no @default(USER) e os defaults ficam nulos. Só o Superadmin
    // envia esses campos (via /superadmin/users).
    const user = await this.userRepository.create({
      name,
      email,
      password,
      defaultProductDescription,
      avatarUrl,
      parentUserId,
      role,
      defaultCostPrice,
      defaultStock,
    });
    return user;
  }

  async login({ email, password }: UserCreate): Promise<User> {
    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      throw new Error("User not found");
    }
    // Validação com bcrypt + rehash transparente do legado em texto plano.
    const { valid, needsRehash } = await verifyPassword(
      password,
      user.password,
    );
    if (!valid) {
      throw new Error("Invalid password");
    }
    if (needsRehash) {
      try {
        await this.userRepository.update(user.id, { password });
      } catch {
        // best-effort: migra no próximo login.
      }
    }
    return user;
  }

  async updateSettings(id: string, data: UserUpdate): Promise<User> {
    const user = await this.userRepository.update(id, data);
    return user;
  }
}

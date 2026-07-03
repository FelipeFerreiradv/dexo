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
  }: UserCreate): Promise<User> {
    const verifyUserExists = await this.userRepository.findByEmail(email);
    if (verifyUserExists) {
      throw new Error("User already exists");
    }
    // parentUserId é opcional e aditivo: o repositório já faz spread condicional,
    // então `undefined` (chamada legada do POST /users) mantém o comportamento
    // idêntico ao anterior — o usuário nasce solto, sem vínculo hierárquico.
    const user = await this.userRepository.create({
      name,
      email,
      password,
      defaultProductDescription,
      avatarUrl,
      parentUserId,
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

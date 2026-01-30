import { User, UserCreate, UserRepository } from "../interfaces/user.interface";
import { UserRepositoryPrisma } from "../repositories/user.repository";

export class UserUseCase {
  private userRepository: UserRepository;
  constructor() {
    this.userRepository = new UserRepositoryPrisma();
  }

  async create({ name, email, password }: UserCreate): Promise<User> {
    const verifyUserExists = await this.userRepository.findByEmail(email);
    if (verifyUserExists) {
      throw new Error("User already exists");
    }
    const user = await this.userRepository.create({ name, email, password });
    return user;
  }

  async login({ email, password }: UserCreate): Promise<User> {
    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      throw new Error("User not found");
    } else if (user.password !== password) {
      throw new Error("Invalid password");
    }
    return user;
  }
}

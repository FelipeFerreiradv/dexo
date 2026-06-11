import { describe, it, expect, vi } from "vitest";
import { CompanyFiscalUseCase } from "../../app/usecases/company-fiscal.usecase";
import { generateTestCertificate } from "./__helpers__/test-certificate";

const EMITTER_CNPJ = "51195502000156";
const OTHER_CNPJ = "11222333000181";
const USER_ID = "user-123";

function makeUseCase(opts: { config: any }) {
  const saveCertificate = vi.fn(
    async (userId: string) => `/storage/certs/${userId}.pfx`,
  );
  const updateCertificate = vi.fn(async (userId: string, data: any) => ({
    ...opts.config,
    ...data,
  }));
  const encryptPassword = vi.fn((s: string) => `enc(${s})`);

  const repo = {
    findByUserId: vi.fn(async () => opts.config),
    updateCertificate,
  };
  const storage = { saveCertificate };
  const certManager = { encryptPassword };

  const useCase = new CompanyFiscalUseCase(
    repo as any,
    storage as any,
    certManager as any,
  );
  return { useCase, saveCertificate, updateCertificate, encryptPassword, repo };
}

describe("CompanyFiscalUseCase.uploadCertificate", () => {
  it("grava certificado valido (disco + senha cifrada + validade)", async () => {
    const tc = generateTestCertificate({
      subjectCN: `EMPRESA TESTE:${EMITTER_CNPJ}`,
      daysValid: 200,
    });
    const { useCase, saveCertificate, updateCertificate, encryptPassword } =
      makeUseCase({ config: { cnpj: EMITTER_CNPJ } });

    const r = await useCase.uploadCertificate(USER_ID, tc.pfxBuffer, tc.password);

    expect(r.ok).toBe(true);
    expect(r.cnpjMatched).toBe(true);
    expect(saveCertificate).toHaveBeenCalledWith(USER_ID, tc.pfxBuffer);
    expect(encryptPassword).toHaveBeenCalledWith(tc.password);
    expect(updateCertificate).toHaveBeenCalledTimes(1);
    const [, data] = updateCertificate.mock.calls[0];
    expect(data.certificadoPath).toBe(`/storage/certs/${USER_ID}.pfx`);
    expect(data.certificadoSenhaEnc).toBe(`enc(${tc.password})`);
    expect(data.certificadoValidoAte.getTime()).toBeGreaterThan(Date.now());
    expect(data.certificadoSubjectCN).toBe(`EMPRESA TESTE:${EMITTER_CNPJ}`);
  });

  it("falha 409 quando a empresa ainda nao foi salva", async () => {
    const tc = generateTestCertificate({ subjectCN: `X:${EMITTER_CNPJ}` });
    const { useCase, saveCertificate, updateCertificate } = makeUseCase({
      config: null,
    });

    const r = await useCase.uploadCertificate(USER_ID, tc.pfxBuffer, tc.password);

    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(saveCertificate).not.toHaveBeenCalled();
    expect(updateCertificate).not.toHaveBeenCalled();
  });

  it("falha 400 e nao persiste quando a senha esta errada", async () => {
    const tc = generateTestCertificate({ subjectCN: `X:${EMITTER_CNPJ}` });
    const { useCase, saveCertificate, updateCertificate } = makeUseCase({
      config: { cnpj: EMITTER_CNPJ },
    });

    const r = await useCase.uploadCertificate(USER_ID, tc.pfxBuffer, "errada");

    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(saveCertificate).not.toHaveBeenCalled();
    expect(updateCertificate).not.toHaveBeenCalled();
  });

  it("falha 400 e nao persiste quando o certificado esta expirado", async () => {
    const tc = generateTestCertificate({
      subjectCN: `X:${EMITTER_CNPJ}`,
      daysValid: -1,
    });
    const { useCase, saveCertificate, updateCertificate } = makeUseCase({
      config: { cnpj: EMITTER_CNPJ },
    });

    const r = await useCase.uploadCertificate(USER_ID, tc.pfxBuffer, tc.password);

    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(saveCertificate).not.toHaveBeenCalled();
    expect(updateCertificate).not.toHaveBeenCalled();
  });

  it("falha 400 e nao persiste quando o CNPJ do cert difere do emissor", async () => {
    const tc = generateTestCertificate({
      subjectCN: `OUTRA:${OTHER_CNPJ}`,
      daysValid: 200,
    });
    const { useCase, saveCertificate, updateCertificate } = makeUseCase({
      config: { cnpj: EMITTER_CNPJ },
    });

    const r = await useCase.uploadCertificate(USER_ID, tc.pfxBuffer, tc.password);

    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/CNPJ/);
    expect(saveCertificate).not.toHaveBeenCalled();
    expect(updateCertificate).not.toHaveBeenCalled();
  });

  it("falha 400 quando a senha vem vazia (sem nem abrir o arquivo)", async () => {
    const tc = generateTestCertificate({ subjectCN: `X:${EMITTER_CNPJ}` });
    const { useCase, repo } = makeUseCase({ config: { cnpj: EMITTER_CNPJ } });

    const r = await useCase.uploadCertificate(USER_ID, tc.pfxBuffer, "");

    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    // validacao de senha vazia ocorre antes de buscar a empresa
    expect(repo.findByUserId).not.toHaveBeenCalled();
  });
});

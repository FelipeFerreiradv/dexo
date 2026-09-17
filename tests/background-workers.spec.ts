import { describe, expect, it } from "vitest";
import { isBackgroundWorkersEnabled } from "../app/lib/background-workers";

describe("isBackgroundWorkersEnabled", () => {
  it.each([
    [{}, false],
    [{ BACKGROUND_WORKERS_ENABLED: "" }, false],
    [{ BACKGROUND_WORKERS_ENABLED: "0" }, false],
    [{ BACKGROUND_WORKERS_ENABLED: "true" }, false],
    [{ BACKGROUND_WORKERS_ENABLED: "1" }, true],
    [
      {
        BACKGROUND_WORKERS_ENABLED: "1",
        BACKGROUND_WORKERS_DISABLED: "1",
      },
      false,
    ],
    [
      {
        BACKGROUND_WORKERS_ENABLED: "1",
        BACKGROUND_WORKERS_DISABLED: "0",
      },
      true,
    ],
  ])("ambiente %o => %s", (env, expected) => {
    expect(isBackgroundWorkersEnabled(env)).toBe(expected);
  });
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { execArgv: ["--experimental-ffi", "--disable-warning=ExperimentalWarning"] },
});

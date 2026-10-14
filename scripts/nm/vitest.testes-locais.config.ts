import path from "node:path";
import { mergeConfig } from "vitest/config";

import base from "../../vitest.config";

// Config do upstream intocada; só acrescenta um setup que roda depois do dele.
// `mergeConfig` concatena `setupFiles`, e os dois projetos (`cercas`,
// `produto`) herdam a raiz via `extends: true`.
export default mergeConfig(base, {
  test: {
    setupFiles: [path.resolve(__dirname, "neutraliza-env.setup.ts")],
  },
});

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// scripts/nm/pr-alcanca-o-nm-ci.sh decide se um PR pula as suítes (partes 1–3)
// e o test:db (partes 4–6) do nm-ci. Errar para "nao" deixa passar regressão
// com o check obrigatório `nm-ci-ok` verde; errar para "sim" só custa minutos.
const SCRIPT = "scripts/nm/pr-alcanca-o-nm-ci.sh";

function responde(caminhos: string[]): Record<string, string> {
  const saida = execFileSync("bash", [SCRIPT], {
    input: caminhos.join("\n") + "\n",
    encoding: "utf-8",
  });
  return Object.fromEntries(saida.trim().split("\n").map((l) => l.split("=") as [string, string]));
}

describe("pr-alcanca-o-nm-ci", () => {
  it("entrada vazia roda tudo — não saber o que mudou nunca vira 'pula'", () => {
    expect(responde([])).toEqual({ suites: "sim", banco: "sim" });
  });

  it("PR só da pasta da marca pula as duas", () => {
    expect(
      responde(["marca/nm-connect/logo.png", "marca/nm-connect/README.md", "marca/nm-connect/gerar.py"]),
    ).toEqual({ suites: "nao", banco: "nao" });
  });

  it("fragmento de release e cerca rodam as suítes, mas não o test:db", () => {
    expect(responde([".changes/x.md", "tests/cercas/selecao.ts"])).toEqual({ suites: "sim", banco: "nao" });
  });

  it.each([
    ["docs/leia.md"],
    ["CLAUDE.md"],
    ["evidence/x/tela.png"],
    ["tasks/todo.md"],
    ["marca/outra-marca/logo.png"],
    ["tests/unit/x.test.ts"],
  ])("%s → as suítes rodam (há cerca que lê)", (caminho) => {
    expect(responde(["marca/nm-connect/logo.png", caminho]).suites).toBe("sim");
  });

  it.each([
    ["lib/qualquer.ts"],
    ["app/globals.css"],
    ["components/agenda/paleta.ts"],
    ["supabase/baseline.sql"],
    ["tests/invariants/x.test.ts"],
    ["scripts/test-db.sh"],
    ["package.json"],
    [".github/workflows/nm-ci.yml"],
    ["docs/architecture/x.architecture.json"],
  ])("%s → roda tudo", (caminho) => {
    expect(responde([".changes/x.md", caminho])).toEqual({ suites: "sim", banco: "sim" });
  });
});

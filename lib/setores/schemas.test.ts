import { describe, expect, it } from "vitest";

import { atualizarSetorSchema, criarSetorSchema } from "./schemas";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

describe("criarSetorSchema", () => {
  it("aceita nome e membros; apara o nome e tira membro repetido", () => {
    const r = criarSetorSchema.parse({ nome: "  Tributário ", membros: [U1, U2, U1] });
    expect(r).toEqual({ nome: "Tributário", membros: [U1, U2] });
  });

  it("membros é opcional e vira lista vazia", () => {
    expect(criarSetorSchema.parse({ nome: "Empresarial" })).toEqual({ nome: "Empresarial", membros: [] });
  });

  it.each([
    ["nome vazio", { nome: "" }],
    ["nome só de espaços", { nome: "   " }],
    ["nome longo demais", { nome: "x".repeat(81) }],
    ["sem nome", {}],
    ["membro que não é uuid", { nome: "A", membros: ["ana"] }],
    ["organization_id no corpo", { nome: "A", organization_id: U1 }],
  ])("recusa %s", (_caso, body) => {
    expect(criarSetorSchema.safeParse(body).success).toBe(false);
  });
});

describe("atualizarSetorSchema", () => {
  it("aceita só o nome, só os membros, ou os dois", () => {
    expect(atualizarSetorSchema.parse({ nome: "Previdenciário" })).toEqual({ nome: "Previdenciário" });
    expect(atualizarSetorSchema.parse({ membros: [] })).toEqual({ membros: [] });
  });

  it("recusa corpo vazio — PATCH que não muda nada é erro de quem chamou", () => {
    expect(atualizarSetorSchema.safeParse({}).success).toBe(false);
  });

  it("recusa campo desconhecido", () => {
    expect(atualizarSetorSchema.safeParse({ nome: "A", cor: "azul" }).success).toBe(false);
  });
});

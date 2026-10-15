import { describe, expect, it } from "vitest";

import { restringirAoSetor } from "./setor";

/**
 * A regra do setor no roteamento humano, pura.
 *
 * `allowed` é o conjunto que o canal já restringiu (`null` = canal sem
 * política, todo mundo da organização pode). O setor só ENCOLHE esse conjunto:
 * nunca devolve alguém que o canal tirou.
 */
describe("restringirAoSetor", () => {
  it("sem setor (null): o conjunto do canal passa intacto", () => {
    const canal = new Set(["ana", "bia"]);
    expect(restringirAoSetor(canal, null)).toBe(canal);
    expect(restringirAoSetor(null, null)).toBeNull();
  });

  it("setor sem membro nenhum: não restringe — comportamento de hoje", () => {
    const canal = new Set(["ana"]);
    expect(restringirAoSetor(canal, [])).toBe(canal);
    expect(restringirAoSetor(null, [])).toBeNull();
  });

  it("canal sem política + setor com membros: só os membros do setor", () => {
    expect(restringirAoSetor(null, ["ana", "caio"])).toEqual(new Set(["ana", "caio"]));
  });

  it("canal com política + setor: a INTERSEÇÃO dos dois", () => {
    expect(restringirAoSetor(new Set(["ana", "bia"]), ["bia", "caio"])).toEqual(new Set(["bia"]));
  });

  it("interseção vazia é vazia — a conversa fica na fila, não cai para outro setor", () => {
    expect(restringirAoSetor(new Set(["ana"]), ["caio"])).toEqual(new Set());
  });
});

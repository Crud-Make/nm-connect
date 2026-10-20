/**
 * Dublês das rotas de `/api/v1/processos` — um só lugar para as quatro rotas.
 *
 * Quem usa declara no próprio arquivo os `vi.mock` de `require-role`, `supabase/server`,
 * `impersonate/support` e `audit` (o `vi.mock` é içado por arquivo e não atravessa import).
 */
import { vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser, Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

export const ORG_ID = "22222222-2222-4222-8222-222222222222";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const CONTATO_ID = "33333333-3333-4333-8333-333333333333";
export const PROCESSO_ID = "44444444-4444-4444-8444-444444444444";
export const ANDAMENTO_ID = "55555555-5555-4555-8555-555555555555";

export function autorizadoComo(role: Role): void {
  const user = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  } as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  } as never);
}

export function negado(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
  } as never);
}

type Resultado = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * Banco falso: todo encadeamento devolve o mesmo `resultado`, e o que a rota pediu fica
 * registrado — filtros, linha inserida e rpc — para o teste conferir.
 */
export function bancoFalso(resultado: Resultado) {
  const filtros: Array<{ coluna: string; valor: unknown }> = [];
  const inserts: unknown[] = [];
  const rpcs: Array<{ nome: string; args: unknown }> = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: (coluna: string, valor: unknown) => {
      filtros.push({ coluna, valor });
      return builder;
    },
    insert: (linha: unknown) => {
      inserts.push(linha);
      return builder;
    },
    single: () => Promise.resolve(resultado),
    then: (resolver: (r: Resultado) => unknown) => Promise.resolve(resultado).then(resolver),
  };
  const client = {
    from: vi.fn(() => builder),
    rpc: vi.fn((nome: string, args: unknown) => {
      rpcs.push({ nome, args });
      return Promise.resolve(resultado);
    }),
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return { client, filtros, inserts, rpcs };
}

export function pedido(caminho: string, method = "GET", corpo?: unknown): NextRequest {
  return new NextRequest(`http://localhost${caminho}`, {
    method,
    ...(corpo === undefined
      ? {}
      : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }),
  });
}

export function comId(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * ADR-0002 D8 (achado da revisão do PR #1578): todo módulo com dados declara a
 * sua seção de export, mesmo sem estar na cascata de redação — honorários não
 * tem texto livre sobre a pessoa (é parâmetro financeiro e calendário), então
 * `tests/unit/lgpd-exporta-o-que-redige.test.ts` (que deriva a lista do que se
 * REDIGE) nunca cobriria esta lacuna. Este arquivo prova a seção diretamente —
 * a de honorários e, com o mesmo banco falso, a de processos (0707).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";
import { logger } from "@/lib/logger";

type Row = Record<string, unknown>;
const ORG = "tenant-a";
const CONTACT = "contact-a";
const LEAD = "lead-a";
const CONTRATO = "contrato-a";
const request = {
  organizationId: ORG,
  requestId: "export-1",
  contactId: CONTACT,
  externalCustomerId: null,
};
let rows: Record<string, Row[]>;
/** 42P01 só para as tabelas de módulo — simula instalação sem os módulos. */
let moduloDesinstalado: boolean;
const TABELAS_DE_MODULO = ["honorarios_contratos", "honorarios_parcelas", "processos", "andamentos"];
/** Erro de leitura que NÃO é "tabela inexistente" numa das tabelas do módulo. */
let falhaDeLeitura: string | null;

class ReadQuery {
  columns = "";
  filters: [string, unknown][] = [];
  ins: [string, unknown[]][] = [];
  page: [number, number] = [0, 100000];
  constructor(readonly table: string) {}
  select(columns: string) {
    this.columns = columns;
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push([key, value]);
    return this;
  }
  in(key: string, values: unknown[]) {
    this.ins.push([key, values]);
    return this;
  }
  order() {
    return this;
  }
  limit(limit: number) {
    this.page = [0, limit - 1];
    return this;
  }
  range(from: number, to: number) {
    this.page = [from, to];
    return this;
  }
  or() {
    return this;
  }
  async maybeSingle() {
    const result = await this.execute();
    return { ...result, data: result.data?.[0] ?? null };
  }
  then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }
  async execute() {
    if (falhaDeLeitura === this.table) {
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
    if (moduloDesinstalado && TABELAS_DE_MODULO.includes(this.table)) {
      return { data: null, error: { code: "42P01", message: "relation does not exist" } };
    }
    const data = (rows[this.table] ?? [])
      .filter((row) => this.filters.every(([key, value]) => row[key] === value))
      .filter((row) => this.ins.every(([key, values]) => values.includes(row[key])))
      .slice(this.page[0], this.page[1] + 1)
      .map((row) =>
        Object.fromEntries(
          this.columns
            .split(",")
            .map((column) => column.trim())
            .map((column) => [column, row[column]]),
        ),
      );
    return { data, error: null };
  }
}

beforeEach(() => {
  moduloDesinstalado = false;
  falhaDeLeitura = null;
  rows = {
    organizations: [
      { id: ORG, legal_name: "Escritório Teste", display_name: "Teste", dpo_email: null },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        name: "Cliente Teste",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    crm_leads: [
      {
        id: LEAD,
        organization_id: ORG,
        contact_id: CONTACT,
        pipeline_id: "pipeline-a",
        stage_id: "stage-a",
        title: "Caso Teste",
        status: "open",
        value_cents: 500000,
        currency: "BRL",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    honorarios_contratos: [
      {
        id: CONTRATO,
        organization_id: ORG,
        lead_id: LEAD,
        modelo: "fixo",
        valor_fixo_cents: 500000,
        percentual_exito: null,
        repasse_advogado_pct: null,
        created_at: "2026-09-16T00:00:00Z",
      },
    ],
    honorarios_parcelas: [
      {
        id: "parcela-a",
        organization_id: ORG,
        contrato_id: CONTRATO,
        numero: 1,
        vencimento: "2026-10-01",
        valor_cents: 250000,
        status: "pendente",
        financial_entry_id: null,
      },
    ],
  };
  mock.admin.mockReturnValue({ from: (table: string) => new ReadQuery(table) });
});

describe("LGPD: honorários no pedido de acesso (ADR-0002 D8)", () => {
  it("entrega o contrato do titular e o calendário de parcelas dele", async () => {
    const payload = await collectExportData(request);
    expect(payload.honorarios_contratos).toEqual([
      expect.objectContaining({ id: CONTRATO, lead_id: LEAD, modelo: "fixo" }),
    ]);
    expect(payload.honorarios_parcelas).toEqual([
      expect.objectContaining({ id: "parcela-a", contrato_id: CONTRATO, numero: 1 }),
    ]);
  });

  it("módulo não instalado (42P01) → seção vazia, export não quebra, sem log de ruído", async () => {
    moduloDesinstalado = true;
    const payload = await collectExportData(request);
    expect(payload.honorarios_contratos).toEqual([]);
    expect(payload.honorarios_parcelas).toEqual([]);
    // 42P01 aqui é o estado ESPERADO (módulo não instalado), não uma falha de
    // leitura — logar isso como warn a cada export poluiria o sinal de quem
    // vigia o log procurando defeito de verdade.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sem titular, ou titular sem lead: seção vazia e nenhuma consulta ao módulo", async () => {
    const payload = await collectExportData({ ...request, contactId: null });
    expect(payload.honorarios_contratos).toEqual([]);
    expect(payload.honorarios_parcelas).toEqual([]);
  });

  it("contrato de outro lead do mesmo titular não some, mas de outro titular nunca aparece", async () => {
    rows.honorarios_contratos = [
      ...(rows.honorarios_contratos ?? []),
      {
        id: "contrato-de-outro",
        organization_id: ORG,
        lead_id: "lead-de-outro-contato",
        modelo: "exito",
        valor_fixo_cents: null,
        percentual_exito: 20,
        repasse_advogado_pct: null,
        created_at: "2026-09-16T00:00:00Z",
      },
    ];
    const payload = await collectExportData(request);
    expect(payload.honorarios_contratos.map((c) => c.id)).toEqual([CONTRATO]);
  });
  it.each(["honorarios_contratos", "honorarios_parcelas"])(
    "módulo instalado e %s ilegível → o export falha e é retentado, nunca sai incompleto como se fosse completo",
    async (tabela) => {
      falhaDeLeitura = tabela;
      await expect(collectExportData(request)).rejects.toThrow(/honorarios_.*_load_failed/);
    },
  );
});

describe("LGPD: processos no pedido de acesso (ADR-0002 D8, 0707)", () => {
  beforeEach(() => {
    rows.processos = [
      { id: "proc-a", organization_id: ORG, contact_id: CONTACT, numero_cnj: "0000001-00.2026.8.13.0001", apelido: "O divórcio", area: "familia", fase: "conhecimento", advogado_user_id: "adv-1", created_at: "2026-09-16T00:00:00Z" },
      { id: "proc-de-outro", organization_id: ORG, contact_id: "contact-b", apelido: "De outro", area: "civel", fase: "recurso", created_at: "2026-09-16T00:00:00Z" },
    ];
    rows.andamentos = [
      { id: "and-aprovado", organization_id: ORG, processo_id: "proc-a", texto: "Audiência marcada.", status: "aprovado", criado_por: "u-1", aprovado_por: "u-2", aprovado_em: "2026-10-01T00:00:00Z", created_at: "2026-09-30T00:00:00Z" },
      { id: "and-rascunho", organization_id: ORG, processo_id: "proc-a", texto: "rascunho interno", status: "rascunho", criado_por: "u-1", aprovado_por: null, aprovado_em: null, created_at: "2026-10-02T00:00:00Z" },
      { id: "and-de-outro", organization_id: ORG, processo_id: "proc-de-outro", texto: "de outro", status: "aprovado", criado_por: "u-1", aprovado_por: "u-2", aprovado_em: "2026-10-01T00:00:00Z", created_at: "2026-09-30T00:00:00Z" },
    ];
  });

  it("ao titular, só os processos dele e o andamento APROVADO, sem autoria", async () => {
    const payload = await collectExportData(request);
    expect(payload.processos.map((p) => p.id)).toEqual(["proc-a"]);
    expect(payload.andamentos).toEqual([
      { id: "and-aprovado", processo_id: "proc-a", texto: "Audiência marcada.", aprovado_em: "2026-10-01T00:00:00Z" },
    ]);
  });

  it("à equipe, o rascunho e quem escreveu e aprovou", async () => {
    const payload = await collectExportData(request);
    expect(payload.andamentos_da_equipe.map((a) => [a.id, a.status, a.criado_por, a.aprovado_por])).toEqual([
      ["and-aprovado", "aprovado", "u-1", "u-2"],
      ["and-rascunho", "rascunho", "u-1", null],
    ]);
  });

  it("módulo não instalado (42P01) → seções vazias, export não quebra", async () => {
    moduloDesinstalado = true;
    const payload = await collectExportData(request);
    expect([payload.processos, payload.andamentos, payload.andamentos_da_equipe]).toEqual([[], [], []]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["processos", "andamentos"])(
    "módulo instalado e %s ilegível → o export falha e é retentado",
    async (tabela) => {
      falhaDeLeitura = tabela;
      await expect(collectExportData(request)).rejects.toThrow(/(processos|andamentos)_load_failed/);
    },
  );
});

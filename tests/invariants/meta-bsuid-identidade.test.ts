import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O CONTATO QUE CHEGA PELO BSUID (migration 0678) — contra o Postgres de verdade.
 *
 * ═══ O DEFEITO ═══
 *
 * Quem usa username no WhatsApp chega sem telefone; a identidade é o BSUID
 * (`from_user_id`). A mensagem era descartada antes de chegar ao banco. Agora
 * ela chega, e a pergunta passa a ser do banco: a ficha é nova ou já existe?
 * E quando o telefone aparece depois — no webhook com os dois, ou tocando no
 * botão REQUEST_CONTACT_INFO —, ele entra na MESMA ficha?
 *
 * ═══ POR QUE AQUI E NÃO NO TESTE UNITÁRIO ═══
 *
 * A junção, a unicidade e a herança na fusão são do banco
 * (`fn_upsert_meta_contact`, o índice parcial e o gatilho). Um mock de RPC que
 * "junta fichas" provaria o mock. Este arquivo aplica o `baseline.sql` (o que o
 * self-hoster recebe) e pergunta ao banco.
 *
 * Congela: (1) BSUID sozinho cria UMA ficha sem telefone, com username;
 * (2) o telefone depois entra na mesma ficha; (3) duas fichas da mesma pessoa
 * se juntam sem duplicar; (4) ficha do BSUID com OUTRO telefone não é misturada;
 * (5) unicidade por organização e isolamento entre organizações; (6) a fusão da
 * tela entrega o BSUID ao vencedor; (7) a anonimização apaga BSUID e username;
 * (8) a função não é alcançável por anon/authenticated.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "b5d1d000-0000-4000-8000-000000000001";
const OUTRA_ORG = "b5d1d000-0000-4000-8000-000000000002";

interface Ficha {
  id: string;
  phone_number: string | null;
  display_name: string | null;
  wa_bsuid: string | null;
  wa_username: string | null;
  is_merged_into: string | null;
  source_metadata: Record<string, unknown>;
}

async function meta(args: {
  org?: string;
  bsuid: string | null;
  username?: string | null;
  phone?: string | null;
  chatId?: string | null;
  notify?: string | null;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "select public.fn_upsert_meta_contact($1, $2, $3, $4, $5, $6) as id",
    [
      args.org ?? ORG,
      args.bsuid,
      args.username ?? null,
      args.phone ?? null,
      args.chatId ?? null,
      args.notify ?? null,
    ],
  );
  return rows[0]!.id;
}

async function porTelefone(phone: string, notify: string | null = null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "select public.fn_upsert_wa_contact($1, 'phone', $2, null, $3, $4) as id",
    [ORG, phone, phone.replace(/\D/g, ""), notify],
  );
  return rows[0]!.id;
}

async function ler(id: string): Promise<Ficha> {
  const { rows } = await pool.query<Ficha>(
    `select id, phone_number, display_name, wa_bsuid, wa_username, is_merged_into, source_metadata
       from contacts where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function vivasCom(campo: "wa_bsuid" | "phone_number", valor: string, org = ORG): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from contacts
      where organization_id = $1 and ${campo} = $2 and is_merged_into is null`,
    [org, valor],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-bsuid-1"],
    [OUTRA_ORG, "org-bsuid-2"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'BSUID LTDA', 'BSUID') on conflict (id) do nothing`,
      [id, slug],
    );
  }
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, OUTRA_ORG]]);
  await pool.end();
});

describe("o lead novo com username, que chega sem telefone", () => {
  it("⭐ BSUID sozinho cria UMA ficha sem telefone, com BSUID, username e nome", async () => {
    const id = await meta({ bsuid: "US.10000000000000000001", username: "realsheenanelson", notify: "Sheena Nelson" });
    const f = await ler(id);
    expect(f).toMatchObject({
      phone_number: null,
      wa_bsuid: "US.10000000000000000001",
      wa_username: "realsheenanelson",
      display_name: "Sheena Nelson",
    });
    // A segunda mensagem da mesma pessoa não abre outra ficha.
    expect(await meta({ bsuid: "US.10000000000000000001", username: "realsheenanelson" })).toBe(id);
    expect(await vivasCom("wa_bsuid", "US.10000000000000000001")).toBe(1);
  });

  it("username novo sobrescreve (é o vigente); o nome do perfil não", async () => {
    const id = await meta({ bsuid: "US.10000000000000000002", username: "antigo", notify: "Nome Um" });
    await meta({ bsuid: "US.10000000000000000002", username: "novo", notify: "Nome Dois" });
    const f = await ler(id);
    expect(f.wa_username).toBe("novo");
    expect(f.display_name).toBe("Nome Um");
  });

  it("BSUID fora do formato da doc sem telefone é recusado — nunca ficha sem identidade", async () => {
    await expect(meta({ bsuid: "<BSUID>" })).rejects.toThrow(/contato_sem_identidade/);
  });
});

describe("o telefone que aparece depois — a mesma ficha, sem duplicar", () => {
  it("⭐ BSUID conhecido + telefone novo: o telefone entra na ficha do BSUID", async () => {
    const id = await meta({ bsuid: "US.20000000000000000001", username: "maria" });
    // REQUEST_CONTACT_INFO ou webhook com os dois: o celular BR chega sem o nono.
    const depois = await meta({ bsuid: "US.20000000000000000001", phone: "+553199990001" });
    expect(depois).toBe(id);
    const f = await ler(id);
    // Gravado COM o nono, como toda ficha deste banco.
    expect(f.phone_number).toBe("+5531999990001");
    expect(f.wa_bsuid).toBe("US.20000000000000000001");
    expect(await vivasCom("phone_number", "+5531999990001")).toBe(1);
  });

  it("⭐ duas fichas da mesma pessoa (a do telefone e a do BSUID) se juntam", async () => {
    // A ficha do telefone existe antes (importação, outro canal)…
    const doTelefone = await porTelefone("+5531999990002", "Joana Silva");
    // …e a pessoa escreve pelo oficial só com o BSUID.
    const doBsuid = await meta({ bsuid: "US.20000000000000000002", username: "joana" });
    expect(doBsuid).not.toBe(doTelefone);

    // Chega o telefone junto do BSUID: as duas viram uma.
    const final = await meta({ bsuid: "US.20000000000000000002", phone: "+5531999990002" });
    // A mais antiga vence — a do telefone, que nasceu primeiro.
    expect(final).toBe(doTelefone);
    const f = await ler(final);
    expect(f).toMatchObject({
      phone_number: "+5531999990002",
      wa_bsuid: "US.20000000000000000002",
      wa_username: "joana",
      display_name: "Joana Silva",
      is_merged_into: null,
    });
    expect((await ler(doBsuid)).is_merged_into).toBe(doTelefone);
    expect(await vivasCom("wa_bsuid", "US.20000000000000000002")).toBe(1);
    expect(await vivasCom("phone_number", "+5531999990002")).toBe(1);
    // E a mensagem seguinte, só pelo BSUID, acha a ficha que ficou.
    expect(await meta({ bsuid: "US.20000000000000000002" })).toBe(doTelefone);
  });

  it("BSUID novo + telefone de ficha existente: a ficha do telefone ganha o BSUID", async () => {
    const doTelefone = await porTelefone("+5531999990003");
    const id = await meta({ bsuid: "US.20000000000000000003", username: "ana", phone: "+5531999990003" });
    expect(id).toBe(doTelefone);
    expect((await ler(id)).wa_bsuid).toBe("US.20000000000000000003");
  });

  it("ficha do BSUID com OUTRO telefone não é misturada: o conflito fica escrito", async () => {
    const a = await meta({ bsuid: "US.20000000000000000004", phone: "+5531999990004" });
    const outra = await porTelefone("+5531999990005");
    const r = await meta({ bsuid: "US.20000000000000000004", phone: "+5531999990005" });
    expect(r).toBe(a);
    const f = await ler(a);
    expect(f.phone_number).toBe("+5531999990004");
    expect(f.source_metadata.telefone_em_conflito).toBe("+5531999990005");
    expect((await ler(outra)).is_merged_into).toBeNull();
  });

  it("ficha do telefone que já tem OUTRO BSUID não é sobrescrita (dois portfólios)", async () => {
    const id = await meta({ bsuid: "US.20000000000000000006", phone: "+5531999990006" });
    const r = await meta({ bsuid: "BR.20000000000000000006", phone: "+5531999990006", username: "outro" });
    expect(r).toBe(id);
    const f = await ler(id);
    expect(f.wa_bsuid).toBe("US.20000000000000000006");
    expect(f.source_metadata.bsuid_em_conflito).toBe("BR.20000000000000000006");
    expect(f.wa_username).toBeNull();
  });
});

describe("unicidade por organização", () => {
  it("o mesmo BSUID em outra organização é OUTRA ficha — nada vaza entre elas", async () => {
    const aqui = await meta({ bsuid: "US.30000000000000000001" });
    const la = await meta({ org: OUTRA_ORG, bsuid: "US.30000000000000000001" });
    expect(la).not.toBe(aqui);
    const { rows } = await pool.query<{ organization_id: string }>(
      "select organization_id from contacts where id = $1",
      [la],
    );
    expect(rows[0]!.organization_id).toBe(OUTRA_ORG);
    expect(await vivasCom("wa_bsuid", "US.30000000000000000001", ORG)).toBe(1);
    expect(await vivasCom("wa_bsuid", "US.30000000000000000001", OUTRA_ORG)).toBe(1);
  });

  it("o índice recusa duas fichas vivas com o mesmo BSUID na mesma organização", async () => {
    await meta({ bsuid: "US.30000000000000000002" });
    await expect(
      pool.query(
        `insert into contacts (organization_id, source, source_metadata)
         values ($1, 'whatsapp', '{"meta_bsuid":"US.30000000000000000002"}'::jsonb)`,
        [ORG],
      ),
    ).rejects.toThrow(/uniq_contacts_org_wa_bsuid/);
  });
});

describe("a fusão da tela entrega o BSUID ao vencedor", () => {
  it("⭐ juntar a ficha do BSUID numa ficha sem BSUID: o vencedor herda", async () => {
    const vencedor = await porTelefone("+5531999990007", "Carlos");
    const perdedor = await meta({ bsuid: "US.40000000000000000001", username: "carlos.x" });
    await pool.query("select public.fn_mesclar_contatos($1, $2, $3::uuid[])", [ORG, vencedor, [perdedor]]);
    const f = await ler(vencedor);
    expect(f.wa_bsuid).toBe("US.40000000000000000001");
    expect(f.wa_username).toBe("carlos.x");
    // A próxima mensagem pelo BSUID acha a ficha viva — não refaz a duplicata.
    expect(await meta({ bsuid: "US.40000000000000000001" })).toBe(vencedor);
  });
});

describe("LGPD — BSUID e username são dado pessoal", () => {
  it("a anonimização apaga os dois (eles moram no metadata que a cascata zera)", async () => {
    const id = await meta({ bsuid: "US.50000000000000000001", username: "titular", notify: "Titular" });
    await pool.query("select public.fn_lgpd_cascade_redact_contact($1, $2, gen_random_uuid())", [ORG, id]);
    const f = await ler(id);
    expect(f.wa_bsuid).toBeNull();
    expect(f.wa_username).toBeNull();
    // E quem escrever de novo com o mesmo BSUID é ficha nova: a anonimizada não volta.
    expect(await meta({ bsuid: "US.50000000000000000001" })).not.toBe(id);
  });
});

describe("a função é do backend", () => {
  it("anon e authenticated não executam fn_upsert_meta_contact; service_role sim", async () => {
    const assinatura = "public.fn_upsert_meta_contact(uuid, text, text, text, text, text)";
    const { rows } = await pool.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
              has_function_privilege('service_role', $1, 'EXECUTE') as svc`,
      [assinatura],
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});

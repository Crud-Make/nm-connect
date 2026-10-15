import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { gravaSetorDaConversa, setorParaGravar } from './setor-da-intencao';

/**
 * Quando o roteador GRAVA o setor na conversa — e quando não grava.
 *
 * Decisão: sobrescreve quando o roteador decide de novo COM CONFIANÇA
 * (`classified`/`reclassified`, que já passaram por `minConfidence`). Sticky,
 * fallback, sem-casamento e falha do classificador nunca tocam no setor: não
 * houve decisão nova sobre o assunto da conversa.
 */
describe('setorParaGravar', () => {
  it.each([
    ['classified', 'setor-a', 'setor-a'],
    ['reclassified', 'setor-b', 'setor-b'],
    ['sticky', 'setor-a', null],
    ['fallback', 'setor-a', null],
    ['no_match', 'setor-a', null],
    ['classifier_failed', 'setor-a', null],
    ['no_router', 'setor-a', null],
    ['campanha', 'setor-a', null],
    ['preview', 'setor-a', null],
    ['classified', null, null],
    ['classified', undefined, null],
  ] as const)('%s com setor %s → %s', (outcome, setorId, esperado) => {
    expect(setorParaGravar({ outcome, setorId })).toBe(esperado);
  });

  it('resolução sem o campo (preview/campanha montam objeto literal) → null', () => {
    expect(setorParaGravar({ outcome: 'classified' })).toBeNull();
  });
});

describe('gravaSetorDaConversa', () => {
  it('UPDATE filtra organização e conversa, e só escreve quando muda', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const mudou = await gravaSetorDaConversa({ query } as unknown as pg.Pool, 'org-1', 'conv-1', 'setor-a');
    expect(mudou).toBe(true);
    const [texto, params] = query.mock.calls[0]!;
    expect(String(texto)).toMatch(/update conversations\s+set setor_id = \$3/);
    expect(String(texto)).toContain('organization_id = $1');
    expect(String(texto)).toContain('id = $2');
    expect(String(texto)).toContain('setor_id is distinct from $3');
    expect(params).toEqual(['org-1', 'conv-1', 'setor-a']);
  });

  it('mesmo setor já gravado → rowCount 0 → false', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    expect(await gravaSetorDaConversa({ query } as unknown as pg.Pool, 'org-1', 'conv-1', 'setor-a')).toBe(false);
  });
});

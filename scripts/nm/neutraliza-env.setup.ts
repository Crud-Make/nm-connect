/**
 * Roda DEPOIS de tests/setup/vitest.setup.ts (ver vitest.testes-locais.config.ts).
 *
 * O setup do upstream copia o .env.local para o process.env e só respeita a
 * variável que já existe com valor NÃO vazio (`!process.env[key]`). Exportar
 * vazio no shell não basta: ele sobrescreve. Por isso a neutralização é aqui,
 * removendo as chaves listadas em NM_ENV_NEUTRALIZADAS (separadas por vírgula)
 * depois que o arquivo foi carregado e antes de qualquer teste importar código.
 */
const lista = process.env.NM_ENV_NEUTRALIZADAS ?? "";
for (const chave of lista.split(",").map((c) => c.trim()).filter(Boolean)) {
  delete process.env[chave];
}

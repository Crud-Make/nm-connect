import type { ReactNode } from "react";

/**
 * A casca das telas de módulo (Honorários, Processos…): título, uma linha que diz para que
 * a tela serve e o conteúdo. Os textos chegam já traduzidos — quem sabe o idioma é a página.
 */
export function PaginaDeModulo({
  titulo,
  descricao,
  children,
}: {
  titulo: string;
  descricao: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{titulo}</h1>
        <p className="text-sm text-text-muted">{descricao}</p>
      </div>
      {children}
    </div>
  );
}

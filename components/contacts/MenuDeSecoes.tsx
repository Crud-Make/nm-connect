"use client";

import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";
import type { SecaoDaFicha } from "@/lib/contacts/secoes-da-ficha";
import { List } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const CHAVE_MENU_RECOLHIDO = "ficha-secoes-recolhidas";

interface Props {
  contactId: string;
  secoes: readonly SecaoDaFicha[];
  ativa: string;
  /** O cabeçalho da ficha (nome e ações), que o ☰ acompanha à esquerda. */
  cabecalho: ReactNode;
  children: ReactNode;
}

/**
 * O MENU LATERAL DE SEÇÕES DA FICHA — no lugar das abas do topo.
 *
 * Desktop: menu fixo à esquerda do conteúdo, recolhido pelo ☰. Recolher é preferência POR
 * NAVEGADOR, como os grupos fechados do `Sidebar`: começa aberto em toda renderização (servidor e
 * primeira pintura) e só muda depois do mount, se o `localStorage` tiver algo salvo.
 * Celular: o mesmo ☰ abre as seções numa gaveta, e escolher uma fecha a gaveta.
 *
 * A seção é um LINK para `?secao=` (`replace`, sem rolar para o topo): link colado abre na seção
 * certa, e o botão do meio do mouse abre outra aba, coisa que aba em `useState` não faz.
 */
export function MenuDeSecoes({ contactId, secoes, ativa, cabecalho, children }: Props) {
  const t = useT();
  const navId = useId();
  const [recolhido, setRecolhido] = useState(false);
  const [gavetaAberta, setGavetaAberta] = useState(false);

  useEffect(() => {
    try {
      setRecolhido(window.localStorage.getItem(CHAVE_MENU_RECOLHIDO) === "1");
    } catch {
      // Storage bloqueado (aba privada) — o menu fica aberto, que é o padrão.
    }
  }, []);

  function alternar() {
    const proximo = !recolhido;
    setRecolhido(proximo);
    try {
      window.localStorage.setItem(CHAVE_MENU_RECOLHIDO, proximo ? "1" : "0");
    } catch {
      // O clique vale nesta visita; só não sobrevive a um F5.
    }
  }

  const lista = (aoEscolher?: () => void) => (
    <ul className="space-y-1">
      {secoes.map((secao, i) => {
        const atual = secao.id === ativa;
        return (
          <li key={secao.id}>
            <Link
              href={i === 0 ? `/app/contacts/${contactId}` : `/app/contacts/${contactId}?secao=${secao.id}`}
              replace
              scroll={false}
              aria-current={atual ? "page" : undefined}
              onClick={aoEscolher}
              className={cn(
                "flex items-center rounded-md px-3 py-1.5 text-sm transition-colors",
                atual
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {t(secao.rotulo)}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="hidden shrink-0 md:inline-flex"
          aria-expanded={!recolhido}
          aria-controls={navId}
          aria-label={recolhido ? t("Mostrar seções do contato") : t("Recolher seções do contato")}
          onClick={alternar}
        >
          <List size={20} aria-hidden />
        </Button>
        <Sheet open={gavetaAberta} onOpenChange={setGavetaAberta}>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0 md:hidden"
              aria-label={t("Abrir seções do contato")}
            >
              <List size={22} aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 max-w-[calc(100vw-2rem)] p-4">
            <SheetTitle className="mb-3 text-sm font-medium">{t("Seções do contato")}</SheetTitle>
            {lista(() => setGavetaAberta(false))}
          </SheetContent>
        </Sheet>
        <div className="min-w-0 flex-1">{cabecalho}</div>
      </div>

      <div className="flex items-start gap-6">
        {!recolhido && (
          <nav
            id={navId}
            aria-label={t("Seções do contato")}
            className="sticky top-4 hidden w-44 shrink-0 border-r pr-4 md:block"
          >
            {lista()}
          </nav>
        )}
        <div className="min-w-0 flex-1 space-y-4">{children}</div>
      </div>
    </div>
  );
}

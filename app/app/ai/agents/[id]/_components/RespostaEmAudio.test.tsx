import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { RespostaEmAudio } from "./RespostaEmAudio";

describe("cartão Resposta em nota de voz", () => {
  it("desligado: só o interruptor e a explicação — voz e tom aparecem depois de ligar", () => {
    const onChange = vi.fn();
    render(
      <RespostaEmAudio
        value={{
          voice_reply_enabled: false,
          voice_reply_voice: "marin",
          voice_reply_instructions: "",
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText("Responder áudio com áudio")).not.toBeChecked();
    expect(screen.queryByLabelText("Tom da voz (opcional)")).toBeNull();
    fireEvent.click(screen.getByLabelText("Responder áudio com áudio"));
    expect(onChange).toHaveBeenCalledWith({ voice_reply_enabled: true });
  });

  it("ligado: o tom escrito vai para o estado do formulário", () => {
    const onChange = vi.fn();
    render(
      <RespostaEmAudio
        value={{
          voice_reply_enabled: true,
          voice_reply_voice: "cedar",
          voice_reply_instructions: "",
        }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Tom da voz (opcional)"), {
      target: { value: "Calma." },
    });
    expect(onChange).toHaveBeenCalledWith({ voice_reply_instructions: "Calma." });
    expect(screen.getByText("cedar")).toBeInTheDocument();
  });
});

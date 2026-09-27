import { describe, expect, it } from "vitest";

import {
  AGENT_COMMANDS,
  availableCommands,
  commandForPreset,
  exactCommand,
  matchCommands,
  removeSlashWord,
  slashQueryAt,
  slashWordClosedBySpace,
} from "./agentCommands";

describe("slashQueryAt", () => {
  it("finds a slash word at the start or after whitespace", () => {
    expect(slashQueryAt("/ma", 3)).toEqual({ start: 0, end: 3, query: "ma" });
    expect(slashQueryAt("why is\n/ma", 10)).toEqual({ start: 7, end: 10, query: "ma" });
    expect(slashQueryAt("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("leaves slashes inside words, paths and numbers alone", () => {
    expect(slashQueryAt("and/or", 6)).toBeNull();
    expect(slashQueryAt("see 1/2", 7)).toBeNull();
    expect(slashQueryAt("/usr/bin", 8)).toBeNull();
    expect(slashQueryAt("plain text", 5)).toBeNull();
  });

  it("covers the whole word when the caret is inside it", () => {
    expect(slashQueryAt("/math later", 2)).toEqual({ start: 0, end: 5, query: "math" });
  });
});

describe("matching", () => {
  it("uses one-word names for the four presets", () => {
    expect(AGENT_COMMANDS.map((command) => command.name)).toEqual([
      "dejargon",
      "math",
      "methodology",
      "reverse-engineer",
    ]);
  });

  it("puts prefix matches first and ignores case", () => {
    expect(matchCommands(AGENT_COMMANDS, "M").map((c) => c.name)).toEqual(["math", "methodology"]);
    expect(matchCommands(AGENT_COMMANDS, "eng").map((c) => c.name)).toEqual(["reverse-engineer"]);
    expect(matchCommands(AGENT_COMMANDS, "").length).toBe(4);
    expect(matchCommands(AGENT_COMMANDS, "zzz")).toEqual([]);
  });

  it("only offers presets where there is a document", () => {
    expect(availableCommands({ documentPresets: false })).toEqual([]);
    expect(availableCommands({ documentPresets: true })).toBe(AGENT_COMMANDS);
  });

  it("maps a preset back to its command", () => {
    expect(commandForPreset("reverse_engineer")?.name).toBe("reverse-engineer");
    expect(commandForPreset(null)).toBeNull();
    expect(exactCommand(AGENT_COMMANDS, "Math")?.preset).toBe("explain_math");
    expect(exactCommand(AGENT_COMMANDS, "mat")).toBeNull();
  });
});

describe("taking a command", () => {
  it("removes the word and the space after it", () => {
    const at = slashQueryAt("/math explain this", 5)!;
    expect(removeSlashWord("/math explain this", at)).toEqual({ text: "explain this", caret: 0 });
    const mid = slashQueryAt("explain /math", 13)!;
    expect(removeSlashWord("explain /math", mid)).toEqual({ text: "explain ", caret: 8 });
  });

  it("takes an exact name when a space follows it", () => {
    const hit = slashWordClosedBySpace(AGENT_COMMANDS, "/methodology ", 13);
    expect(hit?.command.name).toBe("methodology");
    expect(hit?.at).toEqual({ start: 0, end: 12, query: "methodology" });
    expect(slashWordClosedBySpace(AGENT_COMMANDS, "/meth ", 6)).toBeNull();
    expect(slashWordClosedBySpace(AGENT_COMMANDS, "and/math ", 9)).toBeNull();
  });
});

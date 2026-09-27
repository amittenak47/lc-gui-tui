/**
 * Slash commands in the Ask composer.
 *
 * Typing `/` at the start of a word opens a picker; picking a command takes the
 * `/word` out of the text and shows it as a chip beside the other composer
 * options. A `/` that matches nothing is just a slash — `and/or`, a path, a
 * fraction all stay text, because only a slash that begins a word is asked
 * about and only a known name is ever taken.
 *
 * Today every command is one of the local backend's document Ask presets. The
 * `kind` is there so agent skills can join the same list later without the
 * composer learning a second syntax.
 */

import type { AskPresetId } from "./AgentSidePanel";

export type AgentCommand = {
  kind: "preset";
  /** What follows the slash. One word; hyphens allowed. */
  name: string;
  /** One line in the picker. */
  hint: string;
  preset: AskPresetId;
};

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  { kind: "preset", name: "dejargon", hint: "Rewrite the passage in plain words", preset: "de_jargon" },
  { kind: "preset", name: "math", hint: "Walk through the math step by step", preset: "explain_math" },
  { kind: "preset", name: "methodology", hint: "Analyze how the work was done", preset: "analyze_methodology" },
  { kind: "preset", name: "reverse-engineer", hint: "Work backwards from the result", preset: "reverse_engineer" },
];

/** The commands this composer offers. Presets need a document behind them. */
export function availableCommands(opts: { documentPresets: boolean }): readonly AgentCommand[] {
  return opts.documentPresets ? AGENT_COMMANDS : [];
}

export function commandForPreset(preset: AskPresetId | null): AgentCommand | null {
  if (!preset) return null;
  return AGENT_COMMANDS.find((command) => command.kind === "preset" && command.preset === preset) ?? null;
}

/** A `/word` under the caret: where it sits in the text, and the word so far. */
export type SlashQuery = { start: number; end: number; query: string };

const COMMAND_CHARS = /^[a-z-]*$/i;

/**
 * The slash word the caret is in, if it is in one.
 *
 * The slash has to begin a word — start of text or after whitespace — and
 * the word may only hold letters and hyphens. Anything else is ordinary text.
 */
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  if (caret < 1 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  if (text[start] !== "/") return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  const query = text.slice(start + 1, end);
  if (!COMMAND_CHARS.test(query)) return null;
  return { start, end, query };
}

/** Name-prefix matches first, then anywhere in the name. */
export function matchCommands(commands: readonly AgentCommand[], query: string): AgentCommand[] {
  const q = query.toLowerCase();
  const prefix = commands.filter((command) => command.name.startsWith(q));
  const inner = commands.filter((command) => !command.name.startsWith(q) && command.name.includes(q));
  return [...prefix, ...inner];
}

/** The command a finished `/word` names exactly, if any. */
export function exactCommand(commands: readonly AgentCommand[], query: string): AgentCommand | null {
  const q = query.toLowerCase();
  return commands.find((command) => command.name === q) ?? null;
}

/**
 * The text with the slash word taken out, and where the caret goes.
 *
 * One space after the word goes with it, so `/math explain this` leaves
 * `explain this` rather than a leading space.
 */
export function removeSlashWord(text: string, at: SlashQuery): { text: string; caret: number } {
  const after = text[at.end] === " " ? at.end + 1 : at.end;
  return { text: text.slice(0, at.start) + text.slice(after), caret: at.start };
}

/**
 * A space typed straight after a complete command name takes it.
 *
 * `caret` is just past that space. Returns the slash word it closed, so the
 * caller can take the command without the picker.
 */
export function slashWordClosedBySpace(
  commands: readonly AgentCommand[],
  text: string,
  caret: number,
): { at: SlashQuery; command: AgentCommand } | null {
  if (caret < 2 || text[caret - 1] !== " ") return null;
  const at = slashQueryAt(text, caret - 1);
  if (!at || at.end !== caret - 1) return null;
  const command = exactCommand(commands, at.query);
  return command ? { at, command } : null;
}

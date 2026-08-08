/**
 * Source-file extensions the document pad opens as readonly code.
 *
 * One map feeds both the file picker's `accept` list and {@link docTypeForName}
 * / {@link languageForName}, so the two cannot drift. Values are Highlight.js-
 * style language ids for a `language-*` class — unused for colouring today, but
 * kept so a highlighter can plug in later without renaming files.
 */

/** Soft ceiling before stuffing a source into localStorage. */
export const CODE_SOURCE_MAX_CHARS = 1_500_000;

/**
 * Extension (with leading dot, lowercased) → language id.
 *
 * Broad enough for "all computer languages" a writer is likely to annotate;
 * not every obscure extension ever — the picker `accept` string has to stay
 * practical, and unknown names still open as plain code.
 */
export const CODE_LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".m": "objectivec",
  ".mm": "objectivec",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".scala": "scala",
  ".sc": "scala",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".lua": "lua",
  ".r": "r",
  ".jl": "julia",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "bash",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".bat": "batch",
  ".cmd": "batch",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".xml": "xml",
  ".xsl": "xml",
  ".xslt": "xml",
  ".svg": "xml",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".mdx": "mdx",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".tf": "hcl",
  ".hcl": "hcl",
  ".nix": "nix",
  ".zig": "zig",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".lisp": "lisp",
  ".el": "lisp",
  ".scm": "scheme",
  ".rkt": "racket",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".sv": "verilog",
  ".vhd": "vhdl",
  ".vhdl": "vhdl",
  ".asm": "asm",
  ".s": "asm",
  ".pl": "perl",
  ".pm": "perl",
  ".groovy": "groovy",
  ".gradle": "groovy",
  ".cmake": "cmake",
  ".diff": "diff",
  ".patch": "diff",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".env": "ini",
  ".properties": "ini",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".editorconfig": "ini",
  ".txt": "plaintext",
  ".log": "plaintext",
  ".csv": "plaintext",
  ".tsv": "plaintext",
  ".wat": "wasm",
  ".sol": "solidity",
  ".move": "move",
  ".cairo": "cairo",
  ".lean": "lean",
  ".adb": "ada",
  ".ads": "ada",
  ".d": "d",
  ".pas": "pascal",
  ".pp": "pascal",
  ".f": "fortran",
  ".f90": "fortran",
  ".f95": "fortran",
  ".for": "fortran",
  ".cob": "cobol",
  ".cbl": "cobol",
  ".nim": "nim",
  ".cr": "crystal",
  // Verilog and the V language both use `.v`; treat as Verilog (`.sv` is clear).
  ".v": "verilog",
};

/** Basename (lowercased, no path) → language id for extensionless sources. */
export const CODE_LANGUAGE_BY_BASENAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  procfile: "plaintext",
  jenkinsfile: "groovy",
  "go.mod": "go",
  "go.sum": "go",
};

/** Dot-extensions for the file picker, derived from the language map. */
export function codeAcceptExtensions(): string[] {
  const exts = new Set<string>();
  for (const ext of Object.keys(CODE_LANGUAGE_BY_EXT)) {
    exts.add(ext.toLowerCase());
  }
  return [...exts].sort();
}

function basenameOf(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/**
 * Language id for a file name, or `"plaintext"` when unknown.
 *
 * Basename wins for names like `Makefile` / `Dockerfile`; otherwise the last
 * extension. Double extensions such as `foo.d.ts` still match on `.ts`.
 */
export function languageForName(name: string): string {
  const base = basenameOf(name);
  const baseLower = base.toLowerCase();
  if (CODE_LANGUAGE_BY_BASENAME[baseLower]) {
    return CODE_LANGUAGE_BY_BASENAME[baseLower];
  }
  const dot = baseLower.lastIndexOf(".");
  if (dot >= 0) {
    const ext = baseLower.slice(dot);
    if (CODE_LANGUAGE_BY_EXT[ext]) return CODE_LANGUAGE_BY_EXT[ext];
  }
  return "plaintext";
}

/** True when the name is a known source extension or special basename. */
export function isCodeName(name: string): boolean {
  const base = basenameOf(name);
  const baseLower = base.toLowerCase();
  if (CODE_LANGUAGE_BY_BASENAME[baseLower]) return true;
  const dot = baseLower.lastIndexOf(".");
  if (dot < 0) return false;
  return Boolean(CODE_LANGUAGE_BY_EXT[baseLower.slice(dot)]);
}

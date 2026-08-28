/**
 * What the shell owns and every workspace borrows.
 *
 * The tab strip made the app two things: a shell that outlives any one
 * workspace — the daemon client, the theme, the pen's prefs, the LLM's health,
 * the strip itself — and a `Workspace` that is mounted per tab and torn down
 * with it. This is the seam between them.
 *
 * It is a context rather than three dozen props because the borrowed values
 * are used at every depth of a workspace, and threading them by hand would
 * have meant editing several thousand lines that otherwise did not need to
 * change. The field names are the names the code already used, so the move
 * stayed a move.
 *
 * Home is a workspace too — `kind: "home"`, no board to load, the chooser
 * painted over an idle canvas, which is what it always was. That is why the
 * library dialogs and the "open another one" icons are not in here: they work
 * the same whether a pad is live or you are looking at the cards, so they stay
 * with the workspace that renders them.
 */

import {
  createContext,
  useContext,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import type { LcClient, SearchOptions } from "./api/client";
import type { CoachCapabilities, CoachFlags, SessionSnapshot } from "./api/types";
import type { InkRecognizer } from "./canvas/ink";
import type { BoardReadingSize } from "./modes/codeFontSize";
import type { TestForwardMode } from "./util/agentPrefs";
import type { AutosaveInterval } from "./util/autosavePref";
import type { TabRecord } from "./util/tabs";

/** The Home overlay's beats as a workspace opens under it. */
export type BrowseMotion = "enter" | "idle" | "busy" | "exit" | "done";

/**
 * Where a workspace hangs its own header controls.
 *
 * The header outlives any one workspace — the strip must not remount when you
 * switch — so the shell renders it, and the parts that belong to whatever is
 * open arrive through `createPortal`. The DOM lands in the header; the React
 * tree stays with the workspace, which is what keeps them wired to its state.
 * Only the active workspace fills them.
 */
export interface HeaderSlots {
  /** Beside the strip: the problem stepper, or Home's prompt. */
  left: HTMLElement | null;
  /** Run / Submit / Open in IDE. */
  center: HTMLElement | null;
  /** Pad icons, gear and Agent — one slot, so their order is the file's. */
  right: HTMLElement | null;
  /** Under the header: the web omnibox. */
  chrome: HTMLElement | null;
  /**
   * Pen island + map chrome. Lives over `.lc-main` so a split still has one
   * toolbar across the page; the focused pane fills it.
   */
  boardChrome: HTMLElement | null;
  /**
   * The coach column.
   *
   * `.lc-side` is `position: absolute; top: 38px`, so its containing block has
   * to stay `.lc-app` — rendering it inside `.lc-main`, which is itself
   * positioned, would drop it 38px below the header instead of against it.
   * The dialogs need no slot: their backdrops are `position: fixed`.
   */
  agentPanel: HTMLElement | null;
}

/**
 * What the active workspace needs on the app wrapper, and on the strip.
 *
 * The classes are global — header height, agent column width, whether the
 * board is dimmed — so with more than one workspace mounted they can only come
 * from the one on screen. The index status rides along because the strip is
 * the shell's but the chunk counts behind the `[indexed]` badge are not.
 */
export interface WorkspaceChrome {
  problem: boolean;
  pad: boolean;
  agentOpen: boolean;
  loading: boolean;
  busy: boolean;
  loadActive: boolean;
  docIndex: {
    status: "idle" | "indexing" | "indexed" | "error";
    meta: unknown;
    error: string | null;
    /** Present when this workspace holds something indexable that is not indexed. */
    onIndex?: (() => void) | null;
    /** Run or resume the embedding pass over what is already indexed. */
    onEmbed?: (() => void) | null;
    /** Pages while chunking, chunks while embedding — two jobs, two units. */
    indexProgress?: { done: number; total: number } | null;
    embedProgress?: { done: number; total: number } | null;
    /** Measured after the first batch; absent until then, never guessed. */
    embedEta?: string | null;
    embedding?: boolean;
    /** Why indexing is off the table right now — a live page, above all. */
    blocked?: string | null;
    /** A sync refusal that still wants a re-index, not a disabled chip. */
    syncIssue?: string | null;
    /*
     * What the Sync walk is doing, for the chip beside the document's name.
     *
     * The pill morphs its own labels and is the thing you tap. These say how
     * far the current stage has got, which is the half you want to read while
     * looking at the document rather than at the pill.
     */
    walkStage?: string | null;
    /** Which half of Index is running — the two skip independently. */
    walkJob?: string | null;
    walkProgress?: { done: number; total: number } | null;
    /** The walk parked on `walkStage`. */
    walkError?: string | null;
  };
}

export const NO_CHROME: WorkspaceChrome = {
  problem: false,
  pad: false,
  agentOpen: false,
  loading: false,
  busy: false,
  loadActive: false,
  docIndex: { status: "idle", meta: null, error: null, onIndex: null },
};

function progressEqual(
  a: { done: number; total: number } | null | undefined,
  b: { done: number; total: number } | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.done === b.done && a.total === b.total;
}

/** True when a chrome update would not change what the shell paints. */
export function chromeLooksSame(current: WorkspaceChrome, next: WorkspaceChrome): boolean {
  return (
    current.problem === next.problem &&
    current.pad === next.pad &&
    current.agentOpen === next.agentOpen &&
    current.loading === next.loading &&
    current.busy === next.busy &&
    current.loadActive === next.loadActive &&
    current.docIndex.status === next.docIndex.status &&
    current.docIndex.meta === next.docIndex.meta &&
    current.docIndex.error === next.docIndex.error &&
    current.docIndex.blocked === next.docIndex.blocked &&
    current.docIndex.syncIssue === next.docIndex.syncIssue &&
    current.docIndex.onIndex === next.docIndex.onIndex &&
    current.docIndex.onEmbed === next.docIndex.onEmbed &&
    current.docIndex.embedding === next.docIndex.embedding &&
    current.docIndex.embedEta === next.docIndex.embedEta &&
    current.docIndex.walkStage === next.docIndex.walkStage &&
    current.docIndex.walkJob === next.docIndex.walkJob &&
    current.docIndex.walkError === next.docIndex.walkError &&
    progressEqual(current.docIndex.walkProgress, next.docIndex.walkProgress) &&
    progressEqual(current.docIndex.indexProgress, next.docIndex.indexProgress) &&
    progressEqual(current.docIndex.embedProgress, next.docIndex.embedProgress)
  );
}

/** What the shell may ask of a workspace before it unmounts it. */
export interface WorkspaceApi {
  /** Commit whatever the autosave has not; no dialog, nothing discarded. */
  park: () => Promise<void>;
  /** The save / discard / cancel dialog. Resolves only if it went through. */
  leave: () => Promise<boolean>;
  /**
   * Abort an in-flight open: generation bump, spinner → check, then idle.
   * The shell closes the chip after this returns.
   */
  abortLoad: () => Promise<void>;
  /**
   * True while this workspace's open is still in flight.
   *
   * Chip close must abort rather than ask to save a document that never
   * landed. Overlay Cancel already goes through `abortLoad`; this is how
   * the × on the chip does the same.
   */
  isLoadActive: () => boolean;
  /**
   * Home chip while Practice (or an entry dialog) is up: back to the cards.
   * Other workspaces omit this.
   */
  showHomeChooser?: () => void;
}

export interface ShellValue {
  client: LcClient;
  mobile: boolean;

  /** In-process daemon is assumed up; this still gates pad sync and tests. */
  serverLink: "checking" | "online" | "offline";
  serverLinkRef: MutableRefObject<"checking" | "online" | "offline">;

  themeId: string;
  setThemeId: Dispatch<SetStateAction<string>>;
  readingSize: BoardReadingSize;
  setReadingSize: Dispatch<SetStateAction<BoardReadingSize>>;
  autosaveMs: AutosaveInterval;
  setAutosaveMs: Dispatch<SetStateAction<AutosaveInterval>>;
  testForward: TestForwardMode;
  setTestForward: Dispatch<SetStateAction<TestForwardMode>>;
  sheetDragLocked: boolean;
  setSheetDragLocked: Dispatch<SetStateAction<boolean>>;
  pdfFilmOpen: boolean;
  setPdfFilmOpen: Dispatch<SetStateAction<boolean>>;
  recognizer: InkRecognizer;

  capabilities: CoachCapabilities | null;
  coachFlags: CoachFlags;
  llmLink: "unknown" | "online" | "offline";
  refreshCoachFlags: () => Promise<void>;

  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsTab: Dispatch<
    SetStateAction<"paths" | "llm" | "serve" | "datasets" | "workspace" | "agent" | undefined>
  >;

  /** Banner text. The shell paints them; a workspace is usually what writes. */
  notice: string | null;
  setNotice: Dispatch<SetStateAction<string | null>>;
  /**
   * Autosave finished. The write already happened; this only decides whether
   * the chrome says so — on-screen pads share one banner, parked pads stay quiet.
   */
  announceAutosave: (tabId: string, title: string) => void;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;

  /**
   * The Home overlay's beats.
   *
   * Home is a workspace, but the beats are the shell's because they outlive
   * it: the overlay has to keep sliding away *after* the tab it belongs to has
   * been switched off, and a workspace cannot own state that survives its own
   * unmount.
   */
  browseMotion: BrowseMotion;
  setBrowseMotion: Dispatch<SetStateAction<BrowseMotion>>;
  holdBrowseOverlay: boolean;
  setHoldBrowseOverlay: Dispatch<SetStateAction<boolean>>;

  session: SessionSnapshot | null;
  setSession: Dispatch<SetStateAction<SessionSnapshot | null>>;
  /**
   * Whether ‹ › walk the session queue rather than the problem bank.
   *
   * Shell state because it is a fact about the *session*, and it has to
   * outlive the workspace switch that opening the next problem performs.
   */
  navigateBySession: boolean;
  setNavigateBySession: Dispatch<SetStateAction<boolean>>;
  bankFilters: SearchOptions;
  setBankFilters: Dispatch<SetStateAction<SearchOptions>>;
  refreshSession: () => Promise<void>;

  /** Tabs. Opening writes a record; the workspace that mounts for it loads. */
  openWorkspace: (tab: TabRecord) => TabRecord;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  patchTab: (id: string, patch: import("./util/tabs").TabPatch) => void;
  /** A web tab's history is on its record, so stepping it is a record edit. */
  webPush: (id: string, entry: import("./util/webPadSession").WebPadEntry) => void;
  webStep: (id: string, delta: number) => void;
  tabsRef: MutableRefObject<import("./util/tabs").TabState>;

  headerSlots: HeaderSlots;
  /** The active workspace reports the wrapper classes it needs. */
  setChrome: (chrome: WorkspaceChrome) => void;
  /** Registers `park` / `leave` / `abortLoad`, and null on the way out. */
  setWorkspaceApi: (id: string, api: WorkspaceApi | null) => void;
  /**
   * Home ↔ Cancel. True from the moment a user-started open begins until
   * the spinner-complete beat finishes (or cancel does). Survives the
   * Home → new-tab handoff, so the chip does not flicker.
   */
  shellLoadActive: boolean;
  setShellLoadActive: Dispatch<SetStateAction<boolean>>;
  /** Mark a newly created chip so its first mount is a user load, not a remount. */
  markUserLoad: (id: string) => void;
  takeUserLoad: (id: string) => boolean;
  /** The load found nothing to open; the shell keeps the chip and prompts. */
  onMissingContent: (tabId: string, title: string, detail: string) => void;
}

export const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell outside the app shell");
  return value;
}

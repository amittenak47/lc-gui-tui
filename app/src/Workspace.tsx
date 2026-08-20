/**
 * The whole loop, wired together.
 *
 * The coach answers when asked: draw, tap Submit, get a verdict and a
 * counterexample. (The ambient every-2m WebSocket mode is wired but off —
 * see `AMBIENT_ENABLED`.)
 *
 * Everything talks to the in-process harness router. Nothing about the
 * corpus, the workspaces, or the RustPython judge lives in the WebView —
 * including which problem set is open: a problem carries its `dataset` slug,
 * and every request that names a task id names the dataset too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useShell } from "./shellContext";

import { LcApiError, type DocIndexStatus, type ProposedAnnotation, type SearchOptions } from "./api/client";
import { AmbientCoach, defaultCoachSocketFactory, type AmbientProbe } from "./api/coachSocket";
import { isTauriRuntime } from "./api/nativeHttp";
import {
  DEFAULT_PAIRING,
} from "./api/pairing";
import type {
  AttemptState,
  CoachProcessEvent,
  DrawReviewEnvelope,
  LazyFillResponse,
  ProblemDetail,
  ReviewResponse,
  RunAction,
  ServerFrame,
  TestResponse,
  VizEnvelope,
} from "./api/types";
import { DEFAULT_DATASET } from "./api/types";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HoldButton } from "./components/HoldButton";
import { LoadingDoodle } from "./components/LoadingDoodle";
import { waitForTopBannersIdle } from "./components/StatusBanner";
import {
  AUTOSAVE_EVENT,
  loadAutosaveInterval,
} from "./util/autosavePref";
import { Board } from "./canvas/Board";
import { inkOpsFrom } from "./canvas/inkCodec";
import { concatInkShards, drainDirtyInkArchives } from "./canvas/inkArchiveClient";
import type { BoardBlob, BoardHandle, ScreenRect } from "./canvas/BoardHandle";
import { studentAuthoredElements, studentElements } from "./canvas/capture";
import type { StructureBaseline } from "./canvas/boardDelta";
import {
  buildSnapshot,
  padContentFingerprint,
  sceneFingerprint,
  structureBaselineFromBoard,
} from "./canvas/snapshot";
import { hasCodeAnnotations, renderAnnotatedCode } from "./canvas/codeAnnotation";
import { BOARD_THEMES } from "./templates/skeleton";
import { statementLinePitch } from "./modes/codeFontSize";
import { sha256Hex } from "./util/codeHash";
import { copyTextToClipboard } from "./util/clipboard";
import { skeletonOf } from "./util/solutionSplit";
import {
  AgentSidePanel,
  AMBIENT_ENABLED,
  type CoachAttachment,
  type AgentChatMessage,
  type CoachPendingAck,
  type CoachReplyRef,
  type AgentSendFlags,
  replyExcerpt,
} from "./modes/AgentSidePanel";
import { assembleAskPrompt, packFootnoteContext, PAD_ASK_CLIP_CHARS, PROBLEM_ASK_CLIP_CHARS } from "./modes/coachMarkContext";
import { AttemptDialog } from "./modes/AttemptDialog";
import { WhiteboardDialog } from "./modes/WhiteboardDialog";
import { describeRunFailure, withConversationContext } from "./modes/coachContext";
import { groupThreads, threadAnchorRef, visibleThreadMessages } from "./modes/coachThreads";
import {
  loadAgentReasoningLevel,
  loadTestForwardMode,
  reasoningAskFields,
  type AgentReasoningLevel,
  type TestForwardMode,
} from "./util/agentPrefs";
import {
  AGENT_SHEET_LOCK_EVENT,
  loadAgentSheetLock,
  saveAgentSheetLock,
} from "./util/agentSheetLockPref";
import { ensureTypingImports } from "./util/pythonImports";

/** Room under the last line of code so a note fits below it. */
const CODE_PAGE_TAIL = 160;
import { WhiteboardLibraryDialog } from "./modes/WhiteboardLibraryDialog";
import { formatTestReport, TestResultsModal } from "./modes/TestResultsModal";
import { AmbientPanel, type AmbientEntry } from "./modes/AmbientPanel";
import { ProblemBrowser } from "./modes/ProblemBrowser";
import { HomeChooser } from "./modes/HomeChooser";
import { ExploreWorkspace } from "./modes/ExploreWorkspace";
import { LinkStrokeOverlay, type LinkChip } from "./modes/LinkStrokeOverlay";
import { collectDomLinkHits, boxesOverlap, type LinkHit } from "./modes/linkHitTest";
import type { StrokeBox } from "./modes/linkStroke";
import { FEATURE_LEETCODE } from "./featureFlags";
import { PseudocodeEditor } from "./modes/PseudocodeEditor";
import { RevealDialog } from "./modes/RevealDialog";
import { buildProblemTemplate } from "./templates/problemBoard";
import {
  buildWhiteboardTemplate,
  countWhiteboardPages,
  WHITEBOARD_DATASET,
  WHITEBOARD_TASK_ID,
  LEGACY_SCRATCHPAD_TASK_ID,
  whiteboardPageId,
} from "./templates/whiteboard";
import { MOBILE_REGION_ORDER, REGION_BLURB, REGIONS, type RegionId } from "./templates/regions";
import { splitProblemKey } from "./util/datasetKey";
import {
  addFootnote,
  footnoteRevision,
  freshFootnoteId,
  freshNoteId,
  freshSubMarkId,
  googleSearchUrl,
  numberFootnotes,
  removeFootnote,
  searchQueryFor,
  threadTitleFrom,
  type DocFootnote,
  type DocFootnoteSubMark,
  type DocFootnoteSubMarkKind,
} from "./util/docFootnotes";
import { footnoteThemeSeed } from "./util/inkPaletteHistory";
import { getDocBytes, hashBytes, putDocBytes } from "./util/docBytes";
import {
  extractDocumentPages,
  extractedPagesFor,
  pageTextForAsk,
  rememberExtractedPages,
} from "./util/docExtract";
import type { DocAnchor } from "./util/docAnchors";
import { installHandednessAttr } from "./util/inkHandedness";
import { openExternalUrl } from "./util/openExternal";
import { WEB_HOME, fetchWebPage, hostLabelFromUrl, webPageWidthForViewport, type WebHtmlSource } from "./util/webPage";
import { installSafeAreaInsets } from "./util/safeArea";
import { CodeDocument } from "./modes/CodeDocument";
import { DocSelectionLayer, type DocSelectionResult } from "./modes/DocSelectionLayer";
import { FootnoteOverview } from "./modes/FootnoteOverview";
import { EpubDocument } from "./modes/EpubDocument";
import { WebDocument } from "./modes/WebDocument";
import { canStepWeb, currentEntry, pushWeb, stepWeb, type WebPadEntry } from "./util/webPadSession";
import {
  HOME_TAB_ID,
  activeTab as activeTabOf,
  newTabId,
  webTabTitle,
  type TabRecord,
  type WebTab,
} from "./util/tabs";
import {
  deleteEdge,
  edgesFor,
  footnoteEdges,
  putEdge,
  makeEdge,
  isUnresolved,
  listEdges,
  replaceWikiEdges,
  sameNode,
  type Edge,
  type NodeRef,
} from "./util/noteLinks";
import { WorkspaceLinkPicker, groupLabel, type LinkTarget } from "./modes/WorkspaceLinkPicker";
import { resolveWikiLinks } from "./util/wikiLinks";
import { PdfDocument, type PdfNav, type PdfThumbRenderer } from "./modes/PdfDocument";
import { PdfPageRail } from "./modes/PdfPageRail";
import { savePdfFilmPref } from "./modes/pdfFilm";
import { AnnotateDialog, type AnnotateDialogKind } from "./modes/AnnotateDialog";
import { SidecarChooser, type SidecarChoice } from "./modes/SidecarChooser";
import { AnnotateDocument } from "./modes/AnnotateDocument";
import { AnnotateMarkdownEditor, isFreshOwnedNote, type AnnotateMarkdownEditorHandle } from "./modes/AnnotateMarkdownEditor";
import { LiveWebPane } from "./modes/LiveWebPane";
import { StatementDocument } from "./modes/StatementDocument";
import {
  buildAnnotateTemplate,
  annotateFrameWidthFromElements,
  annotatePageHeight,
  annotatePageWidthForOpen,
  ANNOTATE_DATASET,
  ANNOTATE_PAGE_W,
  ANNOTATE_REGION,
  ANNOTATE_TASK_ID,
  LEGACY_MD_INK_TASK_ID,
} from "./templates/annotate";
import { BROWSE_PICK_QUIET_MS, browsePickBlocked } from "./util/browsePickGuard";
import {
  buildAnnotateSidecar,
  CODE_SOURCE_MAX_CHARS,
  sidecarWidthWarning,
  exportAnnotateSidecar,
  sidecarNameFor,
  languageForName,
  exportMarkdownNote,
  pickDocumentFile,
  pickSidecarFile,
  readAnnotateSidecar,
} from "./util/annotateFs";
import {
  deleteAnnotateDoc,
  annotateDocLabel,
  setAnnotateDocLabel,
  findAnnotateDocByHash,
  findStaleAnnotateDoc,
  getAnnotateDocMeta,
  freshAnnotateId,
  listAnnotateDocs,
  listAnnotateDocsByHash,
  migrateAnnotateKeysToId,
  getAnnotateDoc,
  hashMarkdown,
  isBinaryDocType,
  AnnotateLibraryFullError,
  restoreAnnotateDoc,
  saveAnnotateDoc,
  uniqueAnnotateName,
  type DocType,
  type AnnotateDoc,
  type AnnotateDocMeta,
} from "./util/annotateStore";
import {
  deleteWhiteboardNotebook,
  getWhiteboardNotebook,
  listWhiteboardNotebooks,
  migrateLegacyWhiteboard,
  renameWhiteboardNotebook,
  restoreWhiteboardNotebook,
  saveWhiteboardNotebook,
  WhiteboardLibraryFullError,
  WHITEBOARD_PAGE_LIMIT,
  whiteboardLibraryCount,
  WHITEBOARD_LIBRARY_LIMIT,
  type WhiteboardNotebook,
} from "./util/whiteboardStore";
import {
  deletePadEverywhere,
  pullPads,
  flushPadSyncQueue,
  applyPadSyncPing,
  PAD_HUB_WINDOW_EVENT,
  PAD_SYNC_PING_MS,
  pushAnnotatePad,
  pushDocBytes,
  pushRolledSnapshots,
  pushProblemPad,
  pushWhiteboardPad,
  restoreTrashedPad,
  sweepPadTrash,
  tombstonePad,
  type PadHubWindowDetail,
} from "./util/padSync";
import { ensureDevicePrefs } from "./util/devicePrefs";
import { requestPersistentStorage, StorageFullError } from "./util/storageQuota";
import {
  deleteProblemBoard,
  getProblemBoard,
  problemPadId,
  putProblemBoard,
} from "./util/problemBoardStore";
import {
  getInkPages,
  annotateDocKey,
  putInkPages,
  whiteboardDocKey,
} from "./util/inkPageStore";
import {
  getPadSnapshot,
  recordRollingSnapshots,
  type PadSnapshotTier,
} from "./util/padSnapshotStore";
import { resolveSolutionSource } from "./util/solutionTemplate";
import { titleFromSlug } from "./util/text";
import { ensureCodingRoom } from "./util/solutionPad";
import { isDarkTheme } from "./theme/appThemes";
import {
  enforceVisibleDrawingCap,
  restoreMessageDrawing,
  setDrawingExpanded,
  visibleDrawings,
  withNewDrawing,
  MAX_VISIBLE_DRAWINGS,
} from "./viz/drawingState";
import {
  applyAnnotation,
  applyHighlight,
  applyViz,
  removeViz,
  type SceneApi,
} from "./viz/apply";
import { renderAnnotation } from "./viz/render/annotation";
import { renderHighlight } from "./viz/render/highlight";
import { parseVizProgram, type VizProgram } from "./viz/schema";

type Mode = "review" | "ambient";

/** One coach composer send, prepared and waiting in the FIFO queue. */
interface CoachSendQueueItem {
  text: string;
  flags: AgentSendFlags;
  userMessageId: string;
  prompt: string;
  attachments?: AgentChatMessage["attachments"];
  threadAnchor: CoachReplyRef | null;
  photos: CoachAttachment[];
  quotedPassage?: string;
  anchorId: string | null;
  omittedMarkCount?: number;
  includedMarkCount?: number;
  questionTruncated?: boolean;
}

const WHITEBOARD_PROBLEM: ProblemDetail = {
  dataset: WHITEBOARD_DATASET,
  key: `${WHITEBOARD_DATASET}/${WHITEBOARD_TASK_ID}`,
  task_id: WHITEBOARD_TASK_ID,
  question_id: null,
  difficulty: null,
  tags: ["whiteboard"],
  problem_description: "Freeform whiteboard — no problem set.",
  starter_code: null,
  entry_point: null,
  cases: [],
};

function isWhiteboard(problem: ProblemDetail | null | undefined): boolean {
  return (
    problem?.task_id === WHITEBOARD_TASK_ID ||
    problem?.task_id === LEGACY_SCRATCHPAD_TASK_ID ||
    problem?.dataset === WHITEBOARD_DATASET ||
    problem?.dataset === "scratchpad"
  );
}

/**
 * Boot theatre (spinner, LLM banners, "Whiteboard" title wait) runs once per
 * JS session — the first workspace. Tab switches remount under the live
 * budget; those must not replay startup.
 */
let sessionColdWorkspace = true;

function consumeSessionColdWorkspace(): boolean {
  if (!sessionColdWorkspace) return false;
  sessionColdWorkspace = false;
  return true;
}

async function flushDirtyInk(board: BoardHandle, docKey: string | null): Promise<void> {
  if (!docKey || board.isInking()) return;
  const dirty = board.takeDirtyInkPages();
  if (dirty.size === 0) return;
  try {
    await putInkPages(docKey, dirty, { dirty: true });
    board.markInkPagesFlushed(dirty.keys());
    // Phase 4: gzip is the worker's job. Do not await it under a save/tick.
    void drainDirtyInkArchives();
  } catch {
    /* stay dirty — the next save retries */
  }
}

async function boardWithAssembledInk(board: BoardHandle, blob: BoardBlob): Promise<BoardBlob> {
  const shards = board.encodedInkShards();
  if (shards.length === 0) return blob;
  return { ...blob, inkC: await concatInkShards(shards) };
}

async function restoreInk(board: BoardHandle, docKey: string | null, blob: { ink?: unknown; inkC?: unknown }): Promise<void> {
  if (docKey) {
    const shards = await getInkPages(docKey);
    if (shards.size > 0) {
      board.ingestInkPages(shards);
      return;
    }
  }
  const ops = inkOpsFrom(blob);
  if (ops.length > 0) board.setInkOps(ops);
}

/**
 * Annotating a document — a scratchpad whose paper is somebody else's pages.
 *
 * Markdown, code, PDF or EPUB: the ids keep their `MD_INK_*` spelling because
 * they are persisted in saved boards and library entries, and renaming them
 * would be a migration bought with nothing but tidiness.
 */
/** Hide under-header busy strip; keep `busy` for disable logic (re-enable later). */

/*
 * How often the app reaches for the daemon and the model.
 *
 * These were 5s and 8s and 12s, chosen one at a time, and together they meant
 * roughly twenty requests a minute leaving a tablet that was sitting there
 * being written on. Nothing on the board needs the answer that promptly: the
 * "Offline" chip is a status light, and every path that actually needs the
 * daemon probes it directly and reports its own failure.
 *
 * So the cadence is one thing now, in one place, at two to six checks a minute
 * — and the recovery paths that matter are untouched. A failed API call still
 * raises `lc-server-unreachable` the moment it happens, and focus and
 * visibility changes still probe immediately, so waking the app is as prompt as
 * it ever was.
 */

const ANNOTATE_PROBLEM: ProblemDetail = {
  dataset: ANNOTATE_DATASET,
  key: `${ANNOTATE_DATASET}/${ANNOTATE_TASK_ID}`,
  task_id: ANNOTATE_TASK_ID,
  question_id: null,
  difficulty: null,
  tags: ["annotate"],
  problem_description: "Document annotation — no problem set.",
  starter_code: null,
  entry_point: null,
  cases: [],
};

function isAnnotate(problem: ProblemDetail | null | undefined): boolean {
  return (
    problem?.task_id === ANNOTATE_TASK_ID ||
    problem?.task_id === LEGACY_MD_INK_TASK_ID ||
    problem?.dataset === ANNOTATE_DATASET ||
    problem?.dataset === "md-ink"
  );
}

function askSurface(problem: ProblemDetail): "whiteboard" | "annotate" | "problem" {
  if (isWhiteboard(problem)) return "whiteboard";
  if (isAnnotate(problem)) return "annotate";
  return "problem";
}

/**
 * Both freeform modes, for the many places that treat them alike.
 *
 * Neither has an attempt on the daemon, a test run, or a solution file; both
 * persist to a local library and both offer save / discard on the way out.
 */
function isLocalPad(problem: ProblemDetail | null | undefined): boolean {
  return isWhiteboard(problem) || isAnnotate(problem);
}

/**
 * One open workspace — a problem, a notebook, a document, a captured page, or
 * Home.
 *
 * Home is in that list on purpose. It was never anything but an idle board
 * with a chooser painted over it, and treating it as a workspace is what keeps
 * the library dialogs, the "open another one" icons and the browse
 * choreography where they already are: they behave the same whether a pad is
 * live or you are looking at the cards, so splitting them across the seam
 * would have meant an API method per action for no gain.
 *
 * Everything a *tab* owns lives here — the scene and its ink, the footnotes,
 * the undo stack, the agent thread — mounted under `key={tab.id}`, so React's
 * teardown is what keeps two tabs from bleeding into each other. Asking on tab
 * B cannot inherit tab A's attached marks, because tab A's marks are not in
 * this instance.
 *
 * Everything the *app* owns is borrowed from `useShell()`, under the names
 * this file already used, so carving it out of `App.tsx` stayed a move rather
 * than a rewrite of code that did not need to change.
 */
export interface WorkspaceProps {
  /** The record this workspace fills; its key is what gets loaded. */
  tab: TabRecord;
  /** The one on screen: it takes input, and it fills the header slots. */
  active: boolean;
  /**
   * Painted, even if not active.
   *
   * Home keeps painting while its overlay slides away over the arriving
   * workspace. A split partner stays painted too — it is on screen, just not
   * the pane that owns the header chrome.
   */
  showing: boolean;
  /** Which half of a split this wrap is, or null when it owns the whole main. */
  splitRole?: "a" | "b" | null;
  /**
   * Keep this board's map chrome mounted even when the other pane is focused.
   *
   * Explore adds its tools onto that same stack rather than painting a second
   * island. The partner board has to keep the stack alive for the slot to exist.
   */
  splitKeepChrome?: boolean;
  /** Explore should wait for the board tray slot instead of painting its own. */
  embedInBoardTray?: boolean;
}

export function Workspace({
  tab,
  active,
  showing,
  splitRole = null,
  splitKeepChrome = false,
  embedInBoardTray = false,
}: WorkspaceProps) {
  const {
    client,
    mobile,
    serverLink,
    serverLinkRef,
    themeId,
    setThemeId,
    readingSize,
    autosaveMs,
    setAutosaveMs,
    testForward,
    setTestForward,
    sheetDragLocked,
    setSheetDragLocked,
    pdfFilmOpen,
    setPdfFilmOpen,
    recognizer,
    capabilities,
    coachFlags,
    llmLink,
    setSettingsOpen,
    setNotice,
    error,
    setError,
    announceAutosave,
    browseMotion,
    setBrowseMotion,
    holdBrowseOverlay,
    setHoldBrowseOverlay,
    session,
    setSession,
    refreshSession,
    navigateBySession,
    setNavigateBySession,
    bankFilters,
    setBankFilters,
    openWorkspace,
    focusTab,
    closeTab,
    patchTab,
    webPush,
    webStep,
    tabsRef,
    headerSlots,
    setChrome,
    setWorkspaceApi,
    setShellLoadActive,
    shellLoadActive,
    takeUserLoad,
    onMissingContent,
  } = useShell();

  useEffect(() => {
    if (!mobile) return;
    return installSafeAreaInsets();
  }, [mobile]);

  // Writing hand mirrors the chrome across the Y-axis — see inkHandedness.
  useEffect(() => installHandednessAttr(), []);

  /**
   * Mobile paging. Desktop keeps the one wide stacked canvas; on a tablet each
   * dashed template frame gets the viewport to itself, in the order a session
   * actually moves through them.
   */
  const [activeRegion, setActiveRegion] = useState<RegionId>("constraints");
  const [whiteboardPageIndex, setWhiteboardPageIndex] = useState(0);
  const [whiteboardPageCount, setWhiteboardPageCount] = useState(1);
  const [whiteboardNotebookId, setWhiteboardNotebookId] = useState<string | null>(null);
  const whiteboardNotebookIdRef = useRef<string | null>(null);
  whiteboardNotebookIdRef.current = whiteboardNotebookId;
  const padHubApplyRef = useRef(false);
  const [whiteboardEntryOpen, setWhiteboardEntryOpen] = useState(false);
  /**
   * The pen owns the code page: the editor stops taking pointers so strokes
   * reach the ink layer instead of the textarea underneath them.
   */
  const [annotateCode, setAnnotateCode] = useState(false);
  /**
   * Monaco's full content height, so the code page can be as tall as the code.
   *
   * Annotation is why this exists. Ink is stored in board scene coordinates; an
   * editor that scrolls its own viewport slides the text out from under marks
   * that stay put, so a note drawn on line 30 ends up beside line 12. Laying
   * the editor out at full height and letting the board do the scrolling puts
   * both on the one transform.
   */
  const [codeContentHeight, setCodeContentHeight] = useState<number | null>(null);
  const [whiteboardLibOpen, setWhiteboardLibOpen] = useState(false);
  const whiteboardLibResumeRef = useRef<(() => void) | null>(null);
  /**
   * What the library held for this notebook when the session opened.
   *
   * Discard used to be a lie. The board autosaves every three seconds, so by
   * the time anyone reached the leave dialog their work was already committed
   * to the library — and "Discard" then did nothing but navigate away, leaving
   * exactly what it claimed to throw out. Which also meant Save was
   * unfalsifiable: it looked like it worked because the autosave had already
   * done it.
   *
   * Keeping the entry point state is what makes both honest. Discard restores
   * this, and a notebook that was not in the library when the session opened is
   * restored by deleting it. The autosave keeps its real job — surviving a
   * crash or a killed tab — without deciding what the writer meant to keep.
   */
  const whiteboardBaselineRef = useRef<{ id: string | null; entry: WhiteboardNotebook | null }>({
    id: null,
    entry: null,
  });
  /**
   * Fingerprint of the notebook as it was opened, for "did they write
   * anything?". Compared against the live board — see {@link whiteboardUntouched}.
   */
  const whiteboardPristineHashRef = useRef<number | null>(null);

  /** The document being annotated: its text, its name, and its content hash. */
  const [annotateSource, setAnnotateSource] = useState<{
    name: string;
    /** Markdown/code text, or captured HTML for web; empty for PDF and EPUB. */
    text: string;
    hash: string;
    docType: DocType;
    /**
     * The file's bytes for PDF and EPUB, held for as long as the pad is open.
     *
     * A copy is in IndexedDB under {@link hash} for the next session; this one
     * is what the renderer parses now. Reading it back out of the store just to
     * hand it to a component in the same tick would be a round trip for
     * nothing.
     */
    bytes?: ArrayBuffer | null;
  } | null>(null);
  /** Address bar for a web snapshot — kept outside the camera-scaled page. */
  const webUrlRef = useRef("");
  const [webUrl, setWebUrl] = useState(WEB_HOME);
  webUrlRef.current = webUrl;
  const [webHtmlSource, setWebHtmlSource] = useState<WebHtmlSource | null>(null);
  /* Read by the open path, which runs before the state it just set has landed. */
  const webHtmlSourceRef = useRef<WebHtmlSource | null>(null);
  webHtmlSourceRef.current = webHtmlSource;
  /** Why the rendered capture was skipped, when it was. */
  const [webHtmlNote, setWebHtmlNote] = useState<string | null>(null);
  /** Library entry this session is writing to, once it has one. */
  const [annotateDocId, setAnnotateDocId] = useState<string | null>(null);
  /** This set is an owned note — its `source` is the document, not a copy. */
  const [annotateOwned, setAnnotateOwned] = useState(false);
  const annotateOwnedRef = useRef(false);
  annotateOwnedRef.current = annotateOwned;
  /**
   * Editing the note's markdown rather than drawing on it.
   *
   * Owned markdown only. Mutually exclusive with the pen: Monaco and the ink
   * layer both want the pointer, and a caret that sometimes draws is worse
   * than either mode on its own.
   */
  const [editMarkdown, setEditMarkdown] = useState(false);
  /** The live buffer while Edit is open — `content.source` until it is saved. */
  const [editBuffer, setEditBuffer] = useState("");
  const editBufferRef = useRef("");
  editBufferRef.current = editBuffer;
  const mdEditorRef = useRef<AnnotateMarkdownEditorHandle | null>(null);
  /*
   * The open is parked on a question: which of this file's annotation sets?
   *
   * A promise held in state rather than a callback chain, because the answer
   * has to arrive *inside* `loadAnnotate` — before the session id is minted and
   * before the board can take a stroke. Resolving it resumes the same open.
   */
  const [sidecarChoice, setSidecarChoice] = useState<{
    docName: string;
    matches: AnnotateDocMeta[];
    resolve: (choice: SidecarChoice) => void;
  } | null>(null);
  /**
   * Marks this reading session has left on the page.
   *
   * State as well as a ref: the ribbons are rendered from it, and the autosave
   * tick — which runs outside React — writes it to the library entry.
   */
  const [annotateFootnotes, setAnnotateFootnotes] = useState<DocFootnote[]>([]);
  const annotateFootnotesRef = useRef<DocFootnote[]>([]);
  annotateFootnotesRef.current = annotateFootnotes;
  /**
   * A quote waiting for the send that will give it a thread to point at.
   *
   * "Coach" on a selection cannot make its footnote there and then: the thread
   * it belongs to does not exist until the writer actually sends something, and
   * a ribbon pointing at nothing is worse than no ribbon. So the anchor waits
   * here, and the next send claims it.
   */
  const pendingQuoteRef = useRef<DocSelectionResult | null>(null);
  /** Footnote overview send upgrades this id from note → coach on first message. */
  const footnoteCoachUpgradeRef = useRef<string | null>(null);
  const [attachedFootnoteIds, setAttachedFootnoteIds] = useState<string[]>([]);
  const attachedFootnoteIdsRef = useRef<string[]>([]);
  attachedFootnoteIdsRef.current = attachedFootnoteIds;
  const [openFootnoteId, setOpenFootnoteId] = useState<string | null>(null);
  const [footnoteOpenThreadId, setFootnoteOpenThreadId] = useState<string | null>(null);
  const [footnoteAnchorRect, setFootnoteAnchorRect] = useState<DOMRect | null>(null);
  const [subMarkMode, setSubMarkMode] = useState<DocFootnoteSubMarkKind | null>(null);
  const [hoveredSubMarkId, setHoveredSubMarkId] = useState<string | null>(null);
  const [activeSubMarkId, setActiveSubMarkId] = useState<string | null>(null);
  const [subMarkPaintTheme, setSubMarkPaintTheme] = useState<{
    color: string;
    palette: string[];
  } | null>(null);
  const subMarkPaintThemeRef = useRef(subMarkPaintTheme);
  subMarkPaintThemeRef.current = subMarkPaintTheme;
  const [coachQuoteSeed, setCoachQuoteSeed] = useState<{
    token: number;
    text: string;
  } | null>(null);
  void setCoachQuoteSeed;
  const [coachFocusThread, setCoachFocusThread] = useState<{
    token: number;
    rootId: string | null;
  } | null>(null);
  /** Board's marker layer — footnote ribbons paint into it, over the ink. */
  const [marksSlot, setMarksSlot] = useState<HTMLElement | null>(null);
  /** Highlighter mode, owned by the board toolbar and read by the doc layer. */
  const [highlighting, setHighlighting] = useState(false);
  /**
   * The Link tool is armed — a stroke from a mark commits an edge.
   *
   * Annotate mode only, and mutually exclusive with the document highlighter:
   * both want the pointer over the page, and a drag that sometimes marks and
   * sometimes links is a coin toss.
   */
  const [linkMode, setLinkMode] = useState(false);
  const [annotateEntryOpen, setAnnotateEntryOpen] = useState(false);
  /*
   * Which library the entry dialog is about.
   *
   * One dialog: a web pad *is* an annotate document, so Save, Recent, Export
   * and Import already act on it correctly. Only the words differ, and they
   * differed badly — holding the globe offered to open a .pdf.
   */
  const [entryKind, setEntryKind] = useState<AnnotateDialogKind>("document");
  const [docIndexStatus, setDocIndexStatus] = useState<
    "idle" | "indexing" | "indexed" | "error"
  >("idle");
  const [docIndexError, setDocIndexError] = useState<string | null>(null);
  const [docIndexMeta, setDocIndexMeta] = useState<DocIndexStatus | null>(null);
  /**
   * What it would take to index whatever is open, kept so the work can be asked
   * for later rather than only at open time (see the web pad's Index button).
   */
  const indexInputsRef = useRef<{
    hash: string;
    name: string;
    docType: DocType;
    text: string;
    bytes: ArrayBuffer | null;
    delayMs: number;
  } | null>(null);
  const indexOpenDocument = useCallback(() => {
    const job = indexInputsRef.current;
    if (!job) return;
    const loadGen = workspaceLoadGenRef.current;
    setDocIndexStatus("indexing");
    setDocIndexError(null);
    window.setTimeout(() => {
      if (workspaceLoadGenRef.current !== loadGen) return;
      void (async () => {
        try {
          const pages = await extractDocumentPages({
            docType: job.docType,
            name: job.name,
            text: job.text,
            bytes: job.bytes,
          });
          rememberExtractedPages(job.hash, pages);
          if (pages.length === 0) {
            if (workspaceLoadGenRef.current === loadGen) setDocIndexStatus("idle");
            return;
          }
          /*
           * Always a rewrite when asked by hand.
           *
           * Indexing is idempotent on page count, which is right for reopening
           * the same file. But the reason to press this a second time is that
           * the *vectors* should be different now — a model was configured —
           * and that moves no page counts, so the guard would skip exactly the
           * case the button exists for.
           */
          const result = await client.putDocIndex(
            job.hash,
            {
              name: job.name,
              doc_type: job.docType,
              pages,
            },
            { force: true },
          );
          if (workspaceLoadGenRef.current !== loadGen) return;
          if (!result.indexed) {
            setDocIndexStatus("error");
            setDocIndexError("the harness did not keep the index");
            return;
          }
          try {
            setDocIndexMeta(await client.getDocIndex(job.hash));
          } catch {
            setDocIndexMeta(null);
          }
          setDocIndexStatus("indexed");
        } catch (cause) {
          if (workspaceLoadGenRef.current !== loadGen) return;
          setDocIndexStatus("error");
          setDocIndexError(messageOf(cause));
        }
      })();
    }, job.delayMs);
  }, [client]);
  // Read from the autosave interval, which must not be torn down and rebuilt
  // every time one of these changes — a restarted timer is a skipped save.
  const annotateSourceRef = useRef<{
    name: string;
    text: string;
    hash: string;
    docType: DocType;
  } | null>(null);
  const annotateDocIdRef = useRef<string | null>(null);
  /**
   * Measured document height, in scene units, driving the page frame.
   *
   * A page that ended before the text did would clip ink off the bottom of a
   * long document, so the frame is grown to the markdown rather than the other
   * way round.
   */
  const [annotateHeight, setAnnotateHeight] = useState<number | null>(null);
  const annotateHeightRef = useRef<number | null>(null);
  annotateHeightRef.current = annotateHeight;
  const [pdfNav, setPdfNav] = useState<PdfNav | null>(null);
  const pdfNavRef = useRef<PdfNav | null>(null);
  pdfNavRef.current = pdfNav;
  const pdfThumbRef = useRef<PdfThumbRenderer | null>(null);
  const [pdfThumbReady, setPdfThumbReady] = useState(false);
  const onPdfThumbRenderer = useCallback((render: PdfThumbRenderer | null) => {
    pdfThumbRef.current = render;
    setPdfThumbReady(Boolean(render));
  }, []);
  const renderPdfThumb = useCallback((page: number) => {
    return pdfThumbRef.current?.(page) ?? Promise.resolve(null);
  }, [pdfThumbReady]);
  const togglePdfFilm = useCallback(() => {
    setPdfFilmOpen((on) => {
      const next = !on;
      savePdfFilmPref(next);
      return next;
    });
  }, []);
  /** Scene width of the open markdown page — viewport-sized on fresh opens. */
  const [annotatePageWidth, setAnnotatePageWidth] = useState(ANNOTATE_PAGE_W);
  /** The width marks were placed at — recorded in an exported sidecar. */
  const annotatePageWidthRef = useRef(ANNOTATE_PAGE_W);
  annotatePageWidthRef.current = annotatePageWidth;
  const onMdInkMeasure = useCallback((height: number) => {
    setAnnotateHeight((prev) =>
      prev !== null && Math.abs(prev - height) < 1 ? prev : height,
    );
  }, []);
  /** Problem statement HTML measure — same paper path as md-ink. */
  const [statementHeight, setStatementHeight] = useState<number | null>(null);
  const onStatementMeasure = useCallback((height: number) => {
    setStatementHeight((prev) =>
      prev !== null && Math.abs(prev - height) < 1 ? prev : height,
    );
  }, []);
  /** Same discard contract as the scratchpad — see `whiteboardBaselineRef`. */
  const annotateBaselineRef = useRef<{ id: string | null; entry: AnnotateDoc | null }>({
    id: null,
    entry: null,
  });
  const annotatePristineHashRef = useRef<number | null>(null);
  /** Footnote revision at open / last explicit save — not merely "any footnotes". */
  const annotatePristineMarksRef = useRef("");
  /** Persistable coach thread at open / last explicit save. */
  const annotatePristineAgentRef = useRef("");
  annotateSourceRef.current = annotateSource;
  annotateDocIdRef.current = annotateDocId;


  /**
   * The record the one mounted workspace belongs to.
   *
   * Not the same thing as "the focused tab", and the difference matters: a
   * notebook id, an index status or a discard all arrive *while* a switch is
   * in flight, and aiming them at whatever is focused at that moment lands
   * them on the incoming tab. Set by each open path, cleared on the way Home.
   */
  const liveTabIdRef = useRef<string | null>(null);

  /** Set by {@link reportMissingTab}; cleared by answering it, or by leaving. */

  /**
   * `loadWhiteboard` has one reason to ask for a whole fresh open — the
   * library is full and the writer has just freed a slot — and `openWhiteboard`
   * is defined below it. The ref is the loop-breaker, not a second entry point.
   */
  const openWhiteboardRef = useRef<(opts?: { notebookId?: string | null; fresh?: boolean }) => void>(
    () => {},
  );



  const pairing = DEFAULT_PAIRING;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen("lc-seed-ready", () => {
        window.dispatchEvent(new Event("lc-seed-ready"));
      }).then((unlisten) => {
        stop = unlisten;
      });
    });
    return () => stop?.();
  }, []);

  /**
   * Ask once for storage the browser will not evict under pressure.
   *
   * Without the grant this origin is "best-effort", which iOS reads as fair
   * game after seven idle days — and what it would take is the annotation
   * library, the offline problem pack and every PDF's bytes at once. Fire and
   * forget: a refusal changes nothing the writer can act on, and everything
   * keeps working either way.
   */
  useEffect(() => {
    void requestPersistentStorage();
    void sweepPadTrash().catch(() => {});
    void drainDirtyInkArchives();
    /*
     * Bring hash-keyed ink and snapshots onto the sidecar id.
     *
     * Runs before any document is opened rather than inside the open path: the
     * open would otherwise race a rename of the very rows it is restoring, and
     * a reader who never opens the migrated file would keep the old keys
     * forever. Idempotent and self-flagging, so this is one localStorage read
     * on every mount after the first.
     */
    void migrateAnnotateKeysToId().catch(() => {});
    const flush = () => {
      const board = boardRef.current;
      if (!board || board.isInking()) return;
      const source = annotateSourceRef.current;
      const key = source
        ? annotateDocIdRef.current
          ? annotateDocKey(annotateDocIdRef.current)
          : null
        : whiteboardNotebookId
          ? whiteboardDocKey(whiteboardNotebookId)
          : null;
      void flushDirtyInk(board, key);
    };
    const onLeave = (event: BeforeUnloadEvent) => {
      const board = boardRef.current;
      if (!board || board.dirtyInkPageCount() === 0) return;
      flush();
      event.preventDefault();
      event.returnValue = "";
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", onLeave);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [whiteboardNotebookId]);

  /** In-process daemon is assumed up; this flag still gates pad sync / tests. */
  /** Something the student should know, but which did not stop the request. */
  /** Boot overlay still waiting for LLM probe → checkmark before dismiss. */

  const boardRef = useRef<BoardHandle | null>(null);


  useEffect(() => {
    if (serverLink !== "online") return;
    let cancelled = false;
    void (async () => {
      try {
        await applyPadSyncPing(client).catch(() => {});
        if (cancelled) return;
        await pullPads(client);
        if (cancelled) return;
        await flushPadSyncQueue(client);
        if (cancelled) return;
        void ensureDevicePrefs(client).catch(() => {});
      } catch {
        /* daemon missing the new routes — keep the local cache */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverLink, client]);

  useEffect(() => {
    if (serverLink !== "online") return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return;
      void applyPadSyncPing(client).catch(() => {});
    };
    const timer = window.setInterval(tick, PAD_SYNC_PING_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [serverLink, client]);

  /** Coach LLM reachability — separate from the harness router itself. */





  /** Home chooser vs today's problem browser when no board is open. */
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const problemRef = useRef<ProblemDetail | null>(null);
  problemRef.current = problem;
  const [mode, setMode] = useState<Mode>("review");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const [pseudocode, setPseudocode] = useState("");
  /** Drives the fade between the browser and the board. */
  const [entering, setEntering] = useState(false);
  /** Board is mounted but opacity-0 until fit settles — avoids a post-load jump. */
  const [boardPreparing, setBoardPreparing] = useState(false);
  /** Keep the problem browser overlay up while the first board fit settles. */
  /**
   * Pad menu / file picker vs the problem list under it.
   *
   * Closing the sheet unmounts it on the same tap; a tablet then delivers that
   * click (or a delayed one after the system picker) onto a problem row.
   * `padOpenLockRef` covers the in-flight open; the quiet window covers the
   * leftover click after it finishes.
   */
  const padOpenLockRef = useRef(0);
  const browsePickQuietUntilRef = useRef(0);
  const workspaceLoadGenRef = useRef(0);
  /** True while pickProblem / openWhiteboard / openAnnotate is in flight. */
  const [workspaceLoadActive, setWorkspaceLoadActive] = useState(false);
  const beginPadOpen = useCallback(() => {
    padOpenLockRef.current += 1;
    browsePickQuietUntilRef.current = Date.now() + BROWSE_PICK_QUIET_MS;
  }, []);
  const endPadOpen = useCallback(() => {
    padOpenLockRef.current = Math.max(0, padOpenLockRef.current - 1);
    browsePickQuietUntilRef.current = Date.now() + BROWSE_PICK_QUIET_MS;
  }, []);

  /** Browser overlay: idle / enter / busy (spin) / exit (slide+spin) / done (check). */
  /** Same spinner → check transition when stepping ‹ › between problems. */
  const [switchMotion, setSwitchMotion] = useState<"idle" | "busy" | "done">("idle");

  /**
   * Play the closing beats of the loading transition — slide away, then check.
   *
   * Call this *after* the workspace is actually on the board. It used to run
   * before: the checkmark landed, and then the page spent another two seconds
   * building itself in full view of somebody who had just been told it was
   * ready. A transition that finishes early is not a transition, it is a
   * decoration over a wait, and it makes the wait feel longer than it is.
   *
   * Preparing must clear *before* the "done" beat. The status UI is
   * `done={motion === "done"}` (and used to also require `!boardPreparing`).
   * Callers left preparing true through the whole hold, so the checkmark
   * never painted — then idle + preparing false landed in one frame and the
   * spinner simply vanished.
   */
  const finishLoadingTransition = useCallback(
    async (fromBrowse: boolean, switching: boolean, loadGen: number) => {
      if (workspaceLoadGenRef.current !== loadGen) return;
      // Keep the board hidden through the checkmark hold. Clearing preparing
      // first used to paint the page under a spinner that had not finished.
      if (fromBrowse) {
        setBrowseMotion("exit");
        await waitMs(slideDurationMs());
        if (workspaceLoadGenRef.current !== loadGen) return;
        setBrowseMotion("done");
        await waitMs(doneHoldMs());
      } else if (switching) {
        setSwitchMotion("done");
        await waitMs(doneHoldMs());
      }
      if (workspaceLoadGenRef.current !== loadGen) return;
      setBoardPreparing(false);
    },
    [],
  );


  /**
   * The board's content width in CSS pixels, for sizing the statement column.
   *
   * Read at seed time rather than passed down, because the template is built
   * before the board has rendered the problem — `window.innerWidth` is the
   * honest answer at that moment, and the first fit re-measures anyway.
   */
  const boardCssWidth = useCallback(() => {
    if (typeof window === "undefined") return 0;
    return Math.round(window.innerWidth);
  }, []);
  /** Active problem-bank filter — header prev/next walk this when there's no session queue. */
  /** Disk practice session from the harness (queue + progress). */
  /**
   * Header ‹ › walks the session queue only after Start / Random. A plain table
   * click is just a cursor — prev/next then walk the filtered problem bank.
   */
  const [canStepPrev, setCanStepPrev] = useState(false);
  const [canStepNext, setCanStepNext] = useState(false);
  /** Distinguishes header Run tests vs Submit for the results panel. */
  const [lastRunKind, setLastRunKind] = useState<"run" | "submit">("run");
  const [coachOpen, setCoachOpen] = useState(false);
  const [codeSlot, setCodeSlot] = useState<ScreenRect | null>(null);
  const deepLinkHandled = useRef(false);
  const lastCodeSlotRef = useRef<ScreenRect | null>(null);

  const onCodeSlot = useCallback((next: ScreenRect | null) => {
    setCodeSlot((prev) => {
      if (prev === next) return prev;
      if (!prev || !next) {
        if (next) lastCodeSlotRef.current = next;
        return next;
      }
      if (
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height &&
        prev.zoom === next.zoom
      ) {
        return prev;
      }
      lastCodeSlotRef.current = next;
      return next;
    });
  }, []);



  const [tests, setTests] = useState<TestResponse | null>(null);
  /**
   * Settings → Coach. Read once at mount and after Settings saves; a daemon
   * too old to report them leaves the defaults, which is the pre-socket
   * behaviour for everything except `ws_runs`.
   */

  /** Attempt state for the open problem, so the leave dialog asks the right question. */
  const [attemptState, setAttemptState] = useState<AttemptState | null>(null);
  /** Pending "you're leaving — save or discard?" choice, with what to do after. */
  const [leaving, setLeaving] = useState<{ run: () => void } | null>(null);
  const [leavingPending, setLeavingPending] = useState(false);
  const [leavingError, setLeavingError] = useState<string | null>(null);
  /** open → exit fade; dialog stays mounted through the fade then unmounts. */
  const [leavingPhase, setLeavingPhase] = useState<"open" | "exit">("open");

  /** "Reset the practice session?" — our own modal, held to confirm. */
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealPending, setRevealPending] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  /** Coach message that offered Hint — bridge nests under that turn. */
  const revealForMessageIdRef = useRef<string | null>(null);

  const [nudges, setNudges] = useState<AmbientEntry[]>([]);
  const [agentMessages, setAgentMessages] = useState<AgentChatMessage[]>([]);
  /**
   * The thread read from the hot paths.
   *
   * `askAgent` is rebuilt whenever its deps change, and adding the whole
   * message list to them would rebuild it on every turn — including mid-send.
   * The ref is the transcript's stable door.
   */
  const agentMessagesRef = useRef<AgentChatMessage[]>([]);
  agentMessagesRef.current = agentMessages;
  /** FIFO coach sends waiting while a turn is in flight. */
  const coachSendQueueRef = useRef<CoachSendQueueItem[]>([]);
  /** Bumped on interrupt/merge so late HTTP/WS results are ignored. */
  const coachRunGenRef = useRef(0);
  /** Pending assistant placeholder for the active coach run. */
  const activeCoachTurnIdRef = useRef<string | null>(null);
  /** Nested coach sends from one composer submit — defer queue drain until outermost ends. */
  const coachSendDepthRef = useRef(0);
  const busyRef = useRef<string | null>(null);
  busyRef.current = busy;
  const drainCoachSendQueueRef = useRef<() => void>(() => {});
  const executeCoachSendRef = useRef<(item: CoachSendQueueItem) => Promise<void>>(
    async () => {},
  );
  /**
   * Footnote overview already shows the thread. Opening the side panel from a
   * send there reintroduces the "half open document" layout the overview was
   * meant to avoid.
   */
  const suppressCoachPanelOpenRef = useRef(false);
  /** How a red test run is handed to the coach. Default wait (card only). */
  const testForwardRef = useRef(testForward);
  testForwardRef.current = testForward;
  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<TestForwardMode>).detail;
      setTestForward(
        next === "wait" || next === "whole-run" || next === "per-case"
          ? next
          : loadTestForwardMode(),
      );
    };
    window.addEventListener("lc-agent-test-forward", onChange);
    return () => window.removeEventListener("lc-agent-test-forward", onChange);
  }, []);
  /** Pin the mobile coach sheet — no drag-to-open/close from the handle. */
  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      setSheetDragLocked(typeof next === "boolean" ? next : loadAgentSheetLock());
    };
    window.addEventListener(AGENT_SHEET_LOCK_EVENT, onChange);
    return () => window.removeEventListener(AGENT_SHEET_LOCK_EVENT, onChange);
  }, []);
  const onToggleSheetLock = useCallback(() => {
    setSheetDragLocked((current) => {
      const next = !current;
      saveAgentSheetLock(next);
      return next;
    });
  }, []);
  /** Thread the composer is inside, if any — narrows what the coach is told. */
  const threadRootIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [coachPhase, setCoachPhase] = useState<string | null>(null);
  const [ambientProvider, setAmbientProvider] = useState<string | null>(null);
  const [lastSkip, setLastSkip] = useState<string | null>(null);

  /** Element ids at the last analysed board, for the stroke-delta check. */
  const lastIdsRef = useRef<Set<string>>(new Set());
  /** Element ids after the last successful Review board send. */
  const lastReviewIdsRef = useRef<Set<string>>(new Set());
  const reviewTurnRef = useRef(0);
  /** Server-ack structure baseline for Phase 3 board_ops. */
  const lastStructureBaselineRef = useRef<StructureBaseline | null>(null);
  const lastPseudocodeHashRef = useRef<string | undefined>(undefined);
  /** Skeleton hash the server acknowledged — what a code delta is anchored to. */
  const lastSkeletonHashRef = useRef<string | undefined>(undefined);
  /**
   * The last test run, formatted for the model. Sent with every coach request
   * so "why did case 3 fail?" needs no copy-paste, and refreshed on every run
   * so the coach never argues from a stale result.
   */
  const lastTestReportRef = useRef<string | null>(null);
  /** Which problem set the open problem came from — every request carries it. */
  const datasetRef = useRef<string>(DEFAULT_DATASET);
  datasetRef.current = problem?.dataset ?? DEFAULT_DATASET;
  /**
   * True once the workspace holds work worth asking about keeping: edited
   * code, a drawn board, a coach exchange, or a test run. An untouched problem
   * skips the save-or-discard dialog entirely.
   */
  const dirtyRef = useRef(false);
  /** The code as loaded, so an untouched editor does not count as work. */
  const loadedSourceRef = useRef("");
  /**
   * Suspends the board autosave between "discard" and the next problem load.
   *
   * `finishAttempt` deletes `board.json` on the daemon, and the 3-second
   * autosave would otherwise write the still-mounted old scene straight back
   * over it — the student would discard their work and find it waiting.
   *
   * The coach thread has the same hazard and the same guard.
   */
  const boardSaveSuspendedRef = useRef(false);
  const agentSaveSuspendedRef = useRef(false);
  const coachRef = useRef<AmbientCoach | null>(null);
  // The recognizer can be swapped after mount; read it through a ref so the
  // ambient loop doesn't need to restart when it lands.
  const recognizerRef = useRef(recognizer);
  recognizerRef.current = recognizer;
  // Read through a ref for the same reason: otherwise every keystroke in the
  // pseudocode editor would tear down and restart the ambient loop.
  const pseudocodeRef = useRef(pseudocode);
  pseudocodeRef.current = pseudocode;

  /**
   * Coach open/close changes the canvas box (side panel or bottom sheet).
   * Nudge Excalidraw + our fit so the board fills the freed space.
   */
  // Desktop whiteboard: coach docks beside the board — refit to the new hole.
  // Pads + mobile: coach overlays; refitting would reflow the reading column
  // into a thin strip the width of whatever is left beside the panel.
  useEffect(() => {
    if (!problem || mobile) return;
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
      boardRef.current?.refitToViewport();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [coachOpen, mobile, problem]);

  // Keep the dashed code frame tall enough for the Monaco solution.
  useEffect(() => {
    if (!problem) return;
    boardRef.current?.fitCodeToSource(pseudocode);
    if (pseudocode !== loadedSourceRef.current) dirtyRef.current = true;
  }, [problem, pseudocode]);


  const sceneApi = useCallback((): SceneApi | null => {
    const board = boardRef.current;
    if (!board) return null;
    return {
      getSceneElements: () => board.getElements(),
      updateScene: (scene) => board.setElements(scene.elements),
    };
  }, []);

  /** Paint only expanded drawings onto the coach lane. */
  const syncDrawingsToBoard = useCallback(
    (messages: AgentChatMessage[]) => {
      const board = boardRef.current;
      const api = sceneApi();
      if (!board || !api) return;
      const visible = visibleDrawings(messages);
      const visibleIds = new Set(visible.map((drawing) => drawing.program.id));
      for (const id of Array.from(
        new Set(
          messages
            .map((message) => message.drawing?.program.id)
            .filter((id): id is string => Boolean(id)),
        ),
      )) {
        if (!visibleIds.has(id)) removeViz(api, id);
      }
      for (const drawing of visible) {
        applyViz(
          api,
          (skeletons) => board.convert(skeletons, { regenerateIds: false }),
          drawing.program,
          drawing.frameIndex ?? 0,
        );
      }
    },
    [sceneApi],
  );

  /** Stage 1 of the ambient sampler: cheap, synchronous, runs every tick. */
  const probe = useCallback((): AmbientProbe => {
    const board = boardRef.current;
    if (!board) return { sceneHash: 0, newElements: 0, hasContent: false };
    const elements = board.getElements();
    const mine = studentElements(elements);
    const inkOps = board.getInkOpCount();
    let added = 0;
    for (const element of mine) {
      if (!lastIdsRef.current.has(element.id)) added += 1;
    }
    return {
      sceneHash: sceneFingerprint(elements, inkOps),
      newElements: added,
      hasContent: mine.length > 0 || inkOps > 0,
    };
  }, []);

  /** Stage 2: recognition, only after stage 1 said the board changed. */
  const capture = useCallback(async () => {
    const board = boardRef.current;
    if (!board) return { recognized_text: "" };
    const snapshot = await buildSnapshot(board, recognizerRef.current, {
      pseudocode: pseudocodeRef.current,
      structureBaseline: lastStructureBaselineRef.current,
      skeletonHash: await sha256Hex(skeletonOf(pseudocodeRef.current)),
      lastSkeletonHash: lastSkeletonHashRef.current,
      lastPseudocodeHash: lastPseudocodeHashRef.current,
    });
    lastIdsRef.current = snapshot.ids;
    return snapshot.board;
  }, []);


  // Debounced board persistence — skip when scene + ink fingerprint is unchanged.
  const lastSavedHashRef = useRef<number | null>(null);
  /** Ink op count at the previous tick, for "is the hand still moving?". */
  const lastTickInkOpsRef = useRef(-1);
  /**
   * What the marks looked like at the last save.
   *
   * Compared alongside the scene fingerprint so an edit that only touches a
   * footnote — a note, a link, a colour — is still a reason to write.
   */
  const lastSavedMarksRef = useRef<string>("");
  /** Has the "out of space" banner already been shown this session? */
  const storageFullShownRef = useRef(false);
  /**
   * Report a full device once, and say whether that is what happened.
   *
   * Once, because the autosave fires every three seconds and the condition
   * persists: the honest message becomes a stuck banner that hides everything
   * said after it. Callers use the return value to decide whether they still
   * have their own handling to do.
   */
  const noteStorageFull = useCallback((cause: unknown): boolean => {
    if (!(cause instanceof StorageFullError)) return false;
    if (!storageFullShownRef.current) {
      storageFullShownRef.current = true;
      setError(messageOf(cause));
    }
    return true;
  }, []);
  useEffect(() => {
    const onAutosave = () => setAutosaveMs(loadAutosaveInterval());
    window.addEventListener(AUTOSAVE_EVENT, onAutosave);
    return () => window.removeEventListener(AUTOSAVE_EVENT, onAutosave);
  }, []);

  useEffect(() => {
    if (!problem) return;
    // Off means off: no interval at all rather than one that ticks and returns.
    if (autosaveMs <= 0) return;
    const timer = window.setInterval(() => {
      const board = boardRef.current;
      if (!board || boardSaveSuspendedRef.current || padHubApplyRef.current) return;
      const elements = board.getElements();
      const inkOps = board.getInkOpCount();
      const hash = sceneFingerprint(elements, inkOps);
      /*
       * The board is not the only thing that changes.
       *
       * A reading session can edit a footnote's notes, save a link on it or
       * colour its ribbon without ever touching the canvas — and the scene
       * fingerprint cannot see any of that, so the tick returned here and none
       * of it was ever written. Typing a note and closing the document lost the
       * note. Mixing the marks into the same comparison is what makes them
       * count as work.
       */
      const marks = isAnnotate(problem) ? footnoteRevision(annotateFootnotesRef.current) : "";
      if (lastSavedHashRef.current === hash && lastSavedMarksRef.current === marks) {
        lastTickInkOpsRef.current = inkOps;
        return;
      }

      /*
       * Not while the tip is on the paper.
       *
       * This used to be a much bigger deferral, and the reason it could shrink
       * is that the cost it was hiding from is mostly gone. Saving meant
       * walking every element and every ink point and handing the lot to
       * `JSON.stringify` on the main thread — blocking, and landing wherever
       * the timer put it, which every so often was under the nib: the stroke
       * stopped dead partway through a letter. So the tick also waited out the
       * gaps *between* letters, with a ceiling so a long burst still got saved.
       *
       * Now the library write is one entry rather than thirty, it goes to
       * IndexedDB rather than through a blocking string store, and the ink is
       * encoded into typed arrays in a single pass instead of stringified. What
       * is left on the main thread is small enough that the between-letters
       * deferral was costing more in unsaved work than it was buying in
       * smoothness. The tip being down is still worth waiting out: it is free
       * to check, and there is nothing to gain from saving a stroke that is
       * halfway drawn.
       */
      lastTickInkOpsRef.current = inkOps;
      if (board.isInking()) return;

      if (isAnnotate(problem)) {
        /*
         * Annotations autosave, the document does not.
         *
         * Same crash-insurance the scratchpad gets, and the same restraint:
         * nothing is written until something has actually been drawn, so
         * opening a document to read it never creates a library entry. Discard
         * on the way out undoes whatever these ticks committed.
         */
        // An untouched board is not an untouched document: a reading session
        // can leave footnotes without ever putting the pen down, and those are
        // exactly as worth keeping as ink.
        const untouched =
          annotatePristineHashRef.current === padContentFingerprint(elements, inkOps) &&
          footnoteRevision(annotateFootnotesRef.current) === annotatePristineMarksRef.current;
        // The tab's dot rides on the comparison the autosave is already making;
        // fingerprinting the scene a second time for a 5px dot would not be.
        patchTab(tab.id, { dirty: !untouched });
        if (untouched) {
          lastSavedHashRef.current = hash;
          lastSavedMarksRef.current = marks;
          return;
        }
        const source = annotateSourceRef.current;
        if (!source) return;
        // Marked attempted before the write rather than after it. The save is
        // async now, so a tick three seconds later would otherwise start a
        // second write of the same scene while the first was still in flight —
        // and on failure, `lastSavedHashRef` staying behind used to mean every
        // subsequent tick re-serialised a library the store had already
        // refused. One attempt per change is the most that can ever help.
        lastSavedHashRef.current = hash;
        lastSavedMarksRef.current = marks;
        const docKey = annotateDocIdRef.current
          ? annotateDocKey(annotateDocIdRef.current)
          : null;
        void (async () => {
          await flushDirtyInk(board, docKey);
          const liveBoard = board.saveBoard({ assembleInk: false });
          try {
            const saved = await saveAnnotateDoc({
              id: annotateDocIdRef.current ?? undefined,
              name: source.name,
              hash: source.hash,
              source: source.text,
              docType: source.docType,
              board: liveBoard,
              footnotes: annotateFootnotesRef.current,
              agent: persistableAgentMessages(agentMessages),
            });
            if (!annotateDocIdRef.current) setAnnotateDocId(saved.id);
            announceAutosave(tab.id, saved.name);
            const snapBoard = await boardWithAssembledInk(board, liveBoard);
            void pushAnnotatePad(client, saved).then((ok) => {
              if (!ok) return;
              void recordRollingSnapshots({
                kind: "annotate",
                key: saved.id,
                name: saved.name,
                board: snapBoard,
                footnotes: saved.footnotes,
                agent: saved.agent,
              }).then((written) => void pushRolledSnapshots(client, written));
            });
          } catch (cause: unknown) {
            noteStorageFull(cause);
          }
        })();
        return;
      }

      if (isWhiteboard(problem)) {
        /*
         * Don't put an untouched notebook in the library.
         *
         * The first tick of a fresh scratchpad has nothing to save but the
         * blank template, and saving it anyway was how the library filled up
         * with empty notebooks nobody asked for — open the scratchpad, change
         * your mind, and three seconds later it is a permanent entry. There is
         * also nothing to protect: a crash here loses a blank page.
         */
        const untouched =
          whiteboardPristineHashRef.current === padContentFingerprint(elements, inkOps);
        patchTab(tab.id, { dirty: !untouched });
        if (untouched) {
          lastSavedHashRef.current = hash;
          return;
        }
      }

      dirtyRef.current = true;
      if (!isLocalPad(problem)) patchTab(tab.id, { dirty: true });
      if (isWhiteboard(problem)) {
        lastSavedHashRef.current = hash;
        void (async () => {
          const liveBoard = board.saveBoard({ assembleInk: false });
          try {
            const saved = await saveWhiteboardNotebook({
              id: whiteboardNotebookId ?? undefined,
              board: liveBoard,
              agent: persistableAgentMessages(agentMessages),
              pageCount: Math.max(whiteboardPageCount, countWhiteboardPages(liveBoard.elements)),
            });
            if (!whiteboardNotebookId) setWhiteboardNotebookId(saved.id);
            await flushDirtyInk(board, whiteboardDocKey(saved.id));
            announceAutosave(tab.id, saved.title);
            const snapBoard = await boardWithAssembledInk(board, liveBoard);
            void pushWhiteboardPad(client, saved).then((ok) => {
              if (!ok) return;
              void recordRollingSnapshots({
                kind: "whiteboard",
                key: saved.id,
                name: saved.title,
                board: snapBoard,
                agent: saved.agent,
                pageCount: saved.pageCount,
              }).then((written) => void pushRolledSnapshots(client, written));
            });
          } catch (cause: unknown) {
            if (cause instanceof WhiteboardLibraryFullError) {
              whiteboardLibResumeRef.current = null;
              setWhiteboardLibOpen(true);
            } else {
              noteStorageFull(cause);
            }
          }
        })();
        return;
      }
      const blob = board.saveBoard();
      void (async () => {
        const padId = problemPadId(problem.dataset, problem.task_id);
        const prev = await getProblemBoard(padId);
        const row = {
          id: padId,
          dataset: problem.dataset,
          taskId: problem.task_id,
          updatedAt: Date.now(),
          syncSeq: prev?.syncSeq ?? 0,
          hubAckUpdatedAt: prev?.hubAckUpdatedAt,
          board: blob,
          agent: persistableAgentMessages(agentMessages),
        };
        await putProblemBoard(row);
        lastSavedHashRef.current = hash;
        await pushProblemPad(client, row);
      })().catch(() => {});
    }, autosaveMs);
    return () => window.clearInterval(timer);
  }, [
    announceAutosave,
    autosaveMs,
    client,
    patchTab,
    problem,
    tab.id,
    whiteboardNotebookId,
    whiteboardPageCount,
    agentMessages,
    noteStorageFull,
  ]);




  const modeHasVision = useCallback(
    (modeName: string) =>
      capabilities?.modes.find((entry) => entry.mode === modeName)?.vision === true,
    [capabilities],
  );

  const syncSolution = useCallback(async () => {
    if (!problem || isLocalPad(problem)) return;
    await client.putSolution(problem.task_id, pseudocodeRef.current, problem.dataset);
  }, [client, problem]);

  /** App-side channel on every coach request: the last test run, as fact. */
  const appMessages = useCallback(
    () => (lastTestReportRef.current ? [lastTestReportRef.current] : undefined),
    [],
  );

  const loadProblem = useCallback(
    async (
      taskId: string,
      bank: SearchOptions | undefined,
      opts: { keepSessionNav?: boolean; tabId: string; userLoad?: boolean },
    ) => {
      if (
        browsePickBlocked(padOpenLockRef.current > 0, browsePickQuietUntilRef.current)
      ) {
        return true;
      }
      // `opened` is the honest answer to "did a workspace appear?" — the
      // caller turns a false into the missing-content prompt.
      let opened = false;
      const loadGen = ++workspaceLoadGenRef.current;
      const offline = serverLinkRef.current !== "online";
      const datasetId = bank?.dataset ?? DEFAULT_DATASET;
      const userLoad = opts.userLoad === true;
      const cold = userLoad && consumeSessionColdWorkspace();
      const fromBrowse = userLoad && !problem;
      const switching = userLoad && Boolean(problem);
      setWorkspaceLoadActive(userLoad);
      if (userLoad) setShellLoadActive(true);
      setActiveRegion("constraints");
      setStatementHeight(null);
      if (cold) setBusy(offline ? "opening offline…" : "loading the workspace…");
      setError(null);
      setTests(null);
      setNudges([]);
      setAgentMessages([]);
      setAnnotateFootnotes([]);
      annotateFootnotesRef.current = [];
      pendingQuoteRef.current = null;
      footnoteCoachUpgradeRef.current = null;
      setOpenFootnoteId(null);
      setFootnoteAnchorRect(null);
      setFootnoteOpenThreadId(null);
      revealForMessageIdRef.current = null;
      lastReviewIdsRef.current = new Set();
      reviewTurnRef.current = 0;
      lastStructureBaselineRef.current = null;
      lastPseudocodeHashRef.current = undefined;
      lastSkeletonHashRef.current = undefined;
      lastTestReportRef.current = null;
      dirtyRef.current = false;
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;
      setAttemptState(null);
      if (bank) setBankFilters(bank);
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
        setBoardPreparing(true);
      }
      if (switching) {
        setSwitchMotion("busy");
        setBoardPreparing(true);
      }
      try {
        if (offline) {
          throw new Error("Practice needs the in-process harness — rebuild the Tauri app.");
        }

        // Materialize the workspace on the PC, then read back the redacted
        // statement for the board template. `resume` is whatever the last
        // visit chose to keep — the daemon already cleared what it did not.
        const loaded = await client.loadProblem(taskId, datasetId);
        if (workspaceLoadGenRef.current !== loadGen) return true;
        setAttemptState(loaded.resume.attempt);
        const detail = await client.getProblem(taskId, datasetId);
        if (workspaceLoadGenRef.current !== loadGen) return true;
        const fresh = ensureCodingRoom(detail.starter_code ?? "");
        let source = fresh;
        try {
          const disk = await client.getSolution(taskId, datasetId);
          if (disk.source.trim().length > 0) {
            source = ensureCodingRoom(resolveSolutionSource(fresh, disk.source));
            // Rewrite disk when we stripped stale ListNode/TreeNode leftovers.
            if (source.trim() !== disk.source.trim()) {
              try {
                await client.putSolution(taskId, source, datasetId);
              } catch {
                /* best-effort — editor still shows the corrected stub */
              }
            }
          }
        } catch {
          // Fresh load — starter_code is fine.
        }
        const padId = problemPadId(datasetId, taskId);
        let livePad = await getProblemBoard(padId);
        try {
          const remote = await client.getProblemPad(datasetId, taskId);
          if (remote?.board) {
            const newer = !livePad || remote.updated_at > livePad.updatedAt;
            if (newer) {
              livePad = {
                id: remote.id || padId,
                dataset: remote.dataset || datasetId,
                taskId: remote.task_id || taskId,
                updatedAt: remote.updated_at,
                syncSeq: remote.sync_seq,
                hubAckUpdatedAt: remote.updated_at,
                board: remote.board as import("./canvas/BoardHandle").BoardBlob,
                agent: Array.isArray(remote.agent) ? remote.agent : [],
              };
              await putProblemBoard(livePad);
            }
          }
        } catch {
          /* first visit has no hub row yet */
        }
        // A saved coach thread comes back with drawings attached to turns.
        const liveAgent =
          livePad && Array.isArray(livePad.agent) && livePad.agent.length > 0
            ? restoreAgentMessages(livePad.agent)
            : [];
        const resumedMessages =
          liveAgent.length > 0
            ? liveAgent
            : restoreAgentMessages(loaded.resume.agent_messages);
        if (resumedMessages.length > 0) setAgentMessages(resumedMessages);

        setPseudocode(source);
        loadedSourceRef.current = source;
        // Mount the board under the overlay / blur, but keep it invisible until
        // fit settles — then crossfade so the viewport does not jump.
        if (workspaceLoadGenRef.current !== loadGen) return true;
        setBoardPreparing(true);
        setProblem(detail);
        opened = true;
        /*
         * The record exists already; what it could not know until now is the
         * problem's display title, which comes off the detail the daemon just
         * returned. `{dataset, task_id}` is the identity either way — the same
         * key every route and store already names.
         */
        patchTab(opts.tabId, {
          title: titleFromSlug(detail.task_id, detail.question_id),
          dataset: detail.dataset ?? datasetId,
          taskId: detail.task_id,
        });
        await refreshSession();

        const resumeBoard = loaded.resume.board as
          | {
              v?: number;
              elements?: unknown[];
              appState?: unknown;
              ink?: unknown[];
              files?: import("./canvas/BoardHandle").BoardBlob["files"];
              inkPalettes?: import("./canvas/BoardHandle").BoardBlob["inkPalettes"];
            }
          | null;
        const liveBoard = livePad?.board as typeof resumeBoard | undefined;
        const saved =
          liveBoard && liveBoard.v === 1 && Array.isArray(liveBoard.elements)
            ? liveBoard
            : resumeBoard;
        const hasSavedBoard =
          saved && saved.v === 1 && Array.isArray(saved.elements) && saved.elements.length > 0;

        let scaffolding:
          | { approach?: string; complexity?: string; walkthrough?: string }
          | undefined;
        if (!hasSavedBoard) {
          try {
            // Scaffolding is optional fluff — don't hold the loading check on a
            // slow local model. Eight seconds is enough for a warm LLM; past
            // that the board opens with the generic HINTS.
            const scaffold = await Promise.race([
              client.scaffoldBoard(detail.task_id, datasetId),
              new Promise<never>((_, reject) => {
                window.setTimeout(() => reject(new Error("scaffold timed out")), 8000);
              }),
            ]);
            scaffolding = {
              approach: scaffold.approach || undefined,
              complexity: scaffold.complexity || undefined,
              walkthrough: scaffold.walkthrough || undefined,
            };
          } catch {
            // LLM optional — fall back to generic HINTS.
          }
        }

        const skeletons = buildProblemTemplate({
          taskId: detail.task_id,
          title: titleFromSlug(detail.task_id, detail.question_id),
          difficulty: detail.difficulty,
          tags: detail.tags,
          description: detail.problem_description,
          caseCount: detail.cases.length,
          dark: isDarkTheme(themeId),
          scaffolding,
          viewportWidth: boardCssWidth(),
        });

        // A saved layout is restored over the fresh template; otherwise seed
        // the template alone. Persisted boards can carry old region geometry,
        // so `restoreBoard` heals them against the current skeletons.
        lastSavedHashRef.current = null;
        // Decoded once, here, and handed to both restore paths below. Never per
        // frame: the renderer's caches are `WeakMap`s keyed on the op object,
        // so fresh objects each frame would defeat them.
        const savedInk = saved ? inkOpsFrom(saved) : [];
        if (hasSavedBoard && saved?.elements) {
          boardRef.current?.restoreBoard(saved.elements, saved.appState, {
            skeletons,
            ink: savedInk,
            files: saved.files,
            inkPalettes: saved.inkPalettes,
          });
        } else {
          boardRef.current?.seedTemplate(skeletons);
        }
        // Restored boards keep ink from whatever theme they were saved under —
        // recolor to the current Appearance choice. Then drop stale coach viz
        // and re-apply only expanded drawings from the chat transcript.
        boardRef.current?.applyThemeInk(themeId);
        boardRef.current?.stripCoachViz();
        boardRef.current?.fitCodeToSource(source);
        lastIdsRef.current = new Set();

        // Wait until every dashed region frame is in the scene before fitting
        // and revealing — otherwise the loading checkmark races an empty board.
        await boardRef.current?.waitForTemplate();
        syncDrawingsToBoard(resumedMessages);
        // Ink first: the page grows to it, and a fit taken before that is a fit
        // against a frame about to change size. See `openWhiteboard`.
        if (hasSavedBoard && saved) {
          const handle = boardRef.current;
          if (handle) await restoreInk(handle, null, saved);
        }
        if (!livePad && hasSavedBoard && saved) {
          const seed = {
            id: padId,
            dataset: datasetId,
            taskId,
            updatedAt: Date.now(),
            board: saved as import("./canvas/BoardHandle").BoardBlob,
            agent: persistableAgentMessages(resumedMessages),
          };
          await putProblemBoard(seed);
          void pushProblemPad(client, seed);
        }
        await boardRef.current?.settleFitView();

        if (userLoad) {
          await finishLoadingTransition(fromBrowse, switching, loadGen);
          if (workspaceLoadGenRef.current !== loadGen) return true;
        }

        setBrowseMotion("idle");
        setSwitchMotion("idle");
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        // The new board is mounted and fitted; autosave may write again.
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setWorkspaceLoadActive(false);
        setShellLoadActive(false);
        setEntering(true);
        window.setTimeout(() => {
          setEntering(false);
        }, boardFadeMs() || 1);
      } catch (cause) {
        if (workspaceLoadGenRef.current !== loadGen) return true;
        setError(messageOf(cause));
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        setWorkspaceLoadActive(false);
        setShellLoadActive(false);
        if (fromBrowse) setBrowseMotion("idle");
        setSwitchMotion("idle");
      } finally {
        if (workspaceLoadGenRef.current === loadGen) {
          setBusy(null);
          setWorkspaceLoadActive(false);
          setShellLoadActive(false);
        }
      }
      return opened;
    },
    [
      boardCssWidth,
      client,
      finishLoadingTransition,
      openWorkspace,
      problem,
      refreshSession,
      setShellLoadActive,
      syncDrawingsToBoard,
      themeId,
    ],
  );

  const loadWhiteboard = useCallback(
    async (opts: {
      notebookId?: string | null;
      fresh?: boolean;
      tabId: string;
      userLoad?: boolean;
    }) => {
      if (busy !== null) return;
      beginPadOpen();
      const loadGen = ++workspaceLoadGenRef.current;
      if (opts?.fresh && !opts.notebookId && whiteboardLibraryCount() >= WHITEBOARD_LIBRARY_LIMIT) {
        endPadOpen();
        // Asks again from the top rather than reusing this tab id: the chip is
        // withdrawn when a load bails, so by resume time that id is gone.
        whiteboardLibResumeRef.current = () => {
          void openWhiteboardRef.current({ fresh: true });
        };
        setWhiteboardLibOpen(true);
        setShellLoadActive(false);
        return;
      }
      /*
       * Same loading transition as pickProblem / openAnnotate — do not invent a
       * parallel path. Scratchpad used to skip the overlay and reveal the
       * board (and coach sheet) mid-prep, which flashed the coach panel open
       * for a frame before it parked at the peek strip.
       *
       * fromBrowse: browser overlay spinner → slide → checkmark → board under
       * preparing → reveal. switching: WorkspaceLoadStatus blur spinner → check.
       * User-started opens pay the spinner. Tab remounts skip it. Boot banners
       * and the "Whiteboard" title wait stay first-open only.
       */
      const userLoad = opts.userLoad === true;
      const cold = userLoad && consumeSessionColdWorkspace();
      const fromBrowse = userLoad && !problem;
      const switching = userLoad && Boolean(problem);
      setWorkspaceLoadActive(userLoad);
      if (userLoad) setShellLoadActive(true);
      if (cold) setBusy("opening whiteboard…");
      setError(null);
      setTests(null);
      setNudges([]);
      setAgentMessages([]);
      setWhiteboardPageIndex(0);
      setWhiteboardEntryOpen(false);
      setCoachOpen(false);
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
        setBoardPreparing(true);
      }
      if (switching) {
        setSwitchMotion("busy");
        setBoardPreparing(true);
      }
      try {
        await applyPadSyncPing(client, { emit: false }).catch(() => {});
        await migrateLegacyWhiteboard(countWhiteboardPages);
        // Mount the board under the overlay / blur, but keep it invisible until
        // fit settles — then crossfade so the coach sheet never paints mid-open.
        if (workspaceLoadGenRef.current !== loadGen) return;
        setBoardPreparing(true);
        setProblem(WHITEBOARD_PROBLEM);
        setPseudocode("");
        loadedSourceRef.current = "";
        lastSavedHashRef.current = null;
        // The record already exists — `openWhiteboard` wrote it before calling
        // here. The title and the notebook id land below, once the entry has
        // been read or the autosave has written one.
        const tabId = opts.tabId;
        liveTabIdRef.current = tabId;

        const dark = isDarkTheme(themeId);
        let restored = false;
        let notebookId: string | null = opts?.notebookId ?? null;

        // Read once and kept: the entry is used for the restore, for the
        // discard baseline, and again for the ink re-apply after the layer
        // mounts. Three reads of the same record would be three trips to the
        // store for a value that cannot have changed in between.
        const notebook = !opts?.fresh && notebookId ? await getWhiteboardNotebook(notebookId) : null;
        if (notebookId) {
          if (notebook) {
            const pages = Math.min(
              WHITEBOARD_PAGE_LIMIT,
              Math.max(1, notebook.pageCount, countWhiteboardPages(notebook.board.elements)),
            );
            const skeletons = buildWhiteboardTemplate(pages, dark);
            boardRef.current?.restoreBoard(notebook.board.elements, notebook.board.appState, {
              skeletons,
              ink: inkOpsFrom(notebook.board),
              files: notebook.board.files,
              inkPalettes: notebook.board.inkPalettes,
            });
            setWhiteboardPageCount(pages);
            setWhiteboardNotebookId(notebook.id);
            patchTab(tabId, { title: notebook.title || "Whiteboard", notebookId: notebook.id });
            if (notebook.agent.length > 0) {
              setAgentMessages(restoreAgentMessages(notebook.agent));
            }
            restored = true;
          }
        }

        if (!restored) {
          const skeletons = buildWhiteboardTemplate(1, dark);
          boardRef.current?.seedTemplate(skeletons);
          setWhiteboardPageCount(1);
          setWhiteboardNotebookId(null);
          notebookId = null;
        }

        // A blank notebook has no baseline, and that is the point: discarding
        // one means deleting whatever the autosave went on to create for it.
        whiteboardBaselineRef.current = {
          id: restored ? notebookId : null,
          entry: restored ? notebook : null,
        };

        boardRef.current?.applyThemeInk(themeId);
        boardRef.current?.stripCoachViz();
        lastIdsRef.current = new Set();
        await boardRef.current?.waitForTemplate();
        /*
         * Ink before the camera, not after.
         *
         * The ink layer can mount after the first restore, so the strokes are
         * re-applied here — and that has to happen *before* the fit, because
         * the page frame grows to whatever has been written on it. Fitting
         * first meant fitting a one-screen frame that was about to become
         * several screens tall, which is the large gap above the writing on
         * open, and why it came right the moment the pen touched down.
         */
        if (restored && notebook) {
          const handle = boardRef.current;
          if (handle) await restoreInk(handle, whiteboardDocKey(notebook.id), notebook.board);
        }
        await boardRef.current?.settleFitView();

        // Taken after the template and any restored ink have landed, so it is
        // the notebook as the writer first sees it. Anything that moves this
        // number from here is something they did.
        {
          const board = boardRef.current;
          whiteboardPristineHashRef.current = board
            ? padContentFingerprint(board.getElements(), board.getInkOpCount())
            : null;
        }

        // Complete the loading transition (same beats and teardown as
        // pickProblem / openAnnotate). Coach stays closed through the reveal.
        if (userLoad) {
          await finishLoadingTransition(fromBrowse, switching, loadGen);
          if (workspaceLoadGenRef.current !== loadGen) return;
        }

        setBrowseMotion("idle");
        setSwitchMotion("idle");
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setWorkspaceLoadActive(false);
        setShellLoadActive(false);
        setCoachOpen(false);
        const title = restored && notebook ? notebook.title : "Whiteboard";
        if (cold) {
          // Banner first (LLM offline, etc.), then the board fade and title.
          await waitForTopBannersIdle();
          if (workspaceLoadGenRef.current !== loadGen) return;
          setEntering(true);
          const fadeMs = boardFadeMs() || 1;
          window.setTimeout(() => {
            setEntering(false);
            boardRef.current?.showPadTitle(title);
          }, fadeMs);
        } else if (userLoad) {
          boardRef.current?.showPadTitle(title);
        }
      } catch (cause) {
        if (workspaceLoadGenRef.current !== loadGen) return;
        setError(messageOf(cause));
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        setWorkspaceLoadActive(false);
        setShellLoadActive(false);
        if (fromBrowse) setBrowseMotion("idle");
        setSwitchMotion("idle");
      } finally {
        endPadOpen();
        if (workspaceLoadGenRef.current === loadGen) {
          setBusy(null);
          setWorkspaceLoadActive(false);
          setShellLoadActive(false);
        }
      }
    },
    [beginPadOpen, busy, client, endPadOpen, finishLoadingTransition, openWorkspace, problem, setShellLoadActive, themeId],
  );

  /**
   * Open a document to annotate — markdown, code, PDF, EPUB or a web snapshot.
   *
   * Either a file the writer just picked, a captured page, or a library entry
   * being reopened. The types differ only in what "the document" is made of:
   * markdown, code and web HTML arrive as text and are stored with the entry;
   * PDF and EPUB arrive as bytes and are stored in IndexedDB under the same
   * content hash. Everything past that — the hash lookup, the restored ink,
   * the stale-file warning, the loading transition — is deliberately one path,
   * because a reader switching between a note and a textbook should not be
   * switching between two apps.
   */
  /**
   * This workspace, as a node in the graph.
   *
   * Null when there is nothing addressable open — Home, or a document still
   * loading. Everything downstream (the links list, the picker, the lift)
   * needs the same answer, and it is one the tab already knows.
   */
  const hereNode = useMemo((): NodeRef | null => {
    if (tab.kind === "whiteboard") {
      return whiteboardNotebookId
        ? { type: "whiteboard", id: whiteboardNotebookId, title: tab.title }
        : null;
    }
    if (tab.kind === "practice") {
      return { type: "practice", id: `${tab.dataset}/${tab.taskId}`, title: tab.title };
    }
    if (tab.kind === "annotate" || tab.kind === "web") {
      return annotateDocId
        ? {
            type: tab.kind === "web" ? "web" : "annotate",
            id: annotateDocId,
            title: annotateSource?.name ?? tab.title,
          }
        : null;
    }
    return null;
  }, [annotateDocId, annotateSource?.name, tab, whiteboardNotebookId]);

  /** Edges touching the live pad, refreshed when it or the graph changes. */
  const [hereEdges, setHereEdges] = useState<Edge[]>([]);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);

  const refreshHereEdges = useCallback(() => {
    const node = hereNode;
    if (!node) {
      setHereEdges([]);
      return;
    }
    void edgesFor(node)
      .then(setHereEdges)
      .catch(() => setHereEdges([]));
  }, [hereNode]);

  useEffect(() => {
    refreshHereEdges();
  }, [refreshHereEdges]);

  /**
   * What this pad is linked to, as rows for the footnote hub.
   *
   * Undirected: a link typed in a note and one drawn back at it are the same
   * adjacency, and a reader hopping the graph does not care which end was
   * written first.
   */
  const workspaceLinkRows = useMemo(() => {
    const here = hereNode;
    if (!here) return [];
    return hereEdges.map((edge) => {
      const other = sameNode(edge.from, here) ? edge.to : edge.from;
      return {
        edgeId: edge.id,
        title: other.title ?? other.id,
        kindLabel: `${groupLabel(other.type)} · ${edge.kind}`,
      };
    });
  }, [hereEdges, hereNode]);

  /** Everything this pad could be linked to: open tabs, then the libraries. */
  const linkTargets = useMemo((): LinkTarget[] => {
    const here = hereNode;
    if (!here) return [];
    const out: LinkTarget[] = [];
    const seen = new Set<string>([`${here.type}:${here.id}`]);
    const add = (node: NodeRef, group: string) => {
      const key = `${node.type}:${node.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ node, group });
    };
    for (const open of tabsRef.current.tabs) {
      if (open.kind === "home") continue;
      if (open.kind === "practice") {
        add({ type: "practice", id: `${open.dataset}/${open.taskId}`, title: open.title }, "Open tabs");
      } else if (open.kind === "whiteboard" && open.notebookId) {
        add({ type: "whiteboard", id: open.notebookId, title: open.title }, "Open tabs");
      } else if (open.kind === "annotate" && open.docId) {
        add({ type: "annotate", id: open.docId, title: open.title }, "Open tabs");
      }
      // Web tabs carry no `docId` on the record — a capture reaches the graph
      // through its annotate sidecar, which the library loop below picks up.
    }
    for (const doc of listAnnotateDocs()) {
      add({ type: "annotate", id: doc.id, title: annotateDocLabel(doc) }, "Notes and documents");
    }
    for (const notebook of listWhiteboardNotebooks()) {
      add({ type: "whiteboard", id: notebook.id, title: notebook.title }, "Whiteboards");
    }
    return out;
  }, [hereNode, tabsRef]);

  /**
   * The marks on this page, positioned for the link overlay.
   *
   * Read from the DOM rather than from anchors: the ribbons are laid out by
   * the selection layer in page coordinates and then ride the board camera, so
   * where they *are* on screen is a question only the browser can answer.
   */
  const pageLinkChips = useCallback((): LinkChip[] => {
    const out: LinkChip[] = [];
    for (const node of document.querySelectorAll<HTMLElement>(".lc-doc-footnote[data-lc-id]")) {
      const id = node.dataset.lcId;
      if (!id) continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const mark = annotateFootnotesRef.current.find((entry) => entry.id === id);
      out.push({
        id,
        kind: "mark",
        label: (mark?.excerpt ?? "mark").slice(0, 28),
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        hitKind: "mark",
        box: { left: box.left, top: box.top, width: box.width, height: box.height },
      });
    }
    return out;
  }, []);

  const resolveLinkHits = useCallback((box: StrokeBox, overlay: HTMLElement | null): LinkHit[] => {
    const hits = collectDomLinkHits(box, overlay);
    const board = boardRef.current;
    const toClient = board?.sceneToClient?.bind(board);
    if (!board || !toClient) return hits;
    const seen = new Set(hits.map((hit) => hit.id));
    const push = (hit: LinkHit) => {
      if (seen.has(hit.id) || !boxesOverlap(box, hit)) return;
      seen.add(hit.id);
      hits.push(hit);
    };
    for (const el of board.getElements()) {
      if (el.isDeleted) continue;
      if (el.customData?.lcRegion || el.customData?.lcVizId) continue;
      const kind =
        el.type === "image" || el.type === "embeddable"
          ? "image"
          : el.type === "freedraw" || el.type === "line" || el.type === "arrow"
            ? "drawing"
            : null;
      if (!kind) continue;
      const a = toClient(el.x, el.y);
      const b = toClient(el.x + el.width, el.y + el.height);
      if (!a || !b) continue;
      push({
        id: `${kind}:${el.id}`,
        label: kind === "image" ? "image" : "drawing",
        kind,
        left: Math.min(a.x, b.x),
        top: Math.min(a.y, b.y),
        width: Math.max(1, Math.abs(b.x - a.x)),
        height: Math.max(1, Math.abs(b.y - a.y)),
      });
    }
    board.getInkStrokes().forEach((stroke, index) => {
      if (stroke.points.length === 0) return;
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const point of stroke.points) {
        const client = toClient(point.x, point.y);
        if (!client) continue;
        left = Math.min(left, client.x);
        top = Math.min(top, client.y);
        right = Math.max(right, client.x);
        bottom = Math.max(bottom, client.y);
      }
      if (!Number.isFinite(left)) return;
      push({
        id: `ink:${index}`,
        label: "drawing",
        kind: "drawing",
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      });
    });
    return hits;
  }, []);

  /**
   * What else in this document is about the mark being dragged from.
   *
   * Retrieval is per file hash, so two sets of ink over one textbook suggest
   * from the same text. Chips are laid out in a column down the right of the
   * page — they have no position of their own, being passages rather than
   * things on screen.
   */
  const suggestLinkChips = useCallback(
    async (originId: string): Promise<LinkChip[]> => {
      const source = annotateSourceRef.current;
      const mark = annotateFootnotesRef.current.find((entry) => entry.id === originId);
      if (!source || !mark?.excerpt) return [];
      const hits = await client.retrieveDoc(source.hash, mark.excerpt, 4);
      const right = window.innerWidth - 150;
      return hits.map((hit, index) => ({
        id: `chunk:${hit.page}:${index}`,
        kind: "suggestion" as const,
        label: (hit.heading ?? hit.text).slice(0, 32),
        x: right,
        y: 180 + index * 62,
      }));
    },
    [client],
  );

  /**
   * Rename what a graph node stands for.
   *
   * The display name only. An annotate node renames its *set*, so the file on
   * disk keeps its name and the hash does not move; a whiteboard renames its
   * notebook. Practice, web and thread nodes are named by things this app does
   * not own, so they decline rather than pretend.
   */
  const renameGraphNode = useCallback((node: NodeRef, title: string) => {
    if (node.type === "annotate" || node.type === "web") {
      setAnnotateDocLabel(node.id, title);
      return;
    }
    if (node.type === "whiteboard") {
      renameWhiteboardNotebook(node.id, title);
    }
  }, []);

  const addWorkspaceLink = useCallback(
    (to: NodeRef) => {
      const here = hereNode;
      setLinkPickerOpen(false);
      if (!here) return;
      void putEdge(makeEdge(here, to, "picker")).then(refreshHereEdges);
    },
    [hereNode, refreshHereEdges],
  );

  const removeWorkspaceLink = useCallback(
    (id: string) => {
      // The edge, never the thing on the other end of it.
      void deleteEdge(id).then(refreshHereEdges);
    },
    [refreshHereEdges],
  );

  const askSidecarChoice = useCallback(
    (docName: string, matches: AnnotateDocMeta[]) =>
      new Promise<SidecarChoice>((resolve) => {
        setSidecarChoice({ docName, matches, resolve });
      }),
    [],
  );

  const loadAnnotate = useCallback(
    async (input: {
      name: string;
      docType?: DocType;
      /** Markdown, code, or captured web HTML. */
      text?: string;
      /** PDF and EPUB only. */
      bytes?: ArrayBuffer;
      docId?: string | null;
      /** The strip record this open fills. Written before the load starts. */
      tabId: string;
      /** Already computed by the caller that had to key the record on it. */
      hash?: string;
      userLoad?: boolean;
    }) => {
      if (busyRef.current !== null) return;
      beginPadOpen();
      const loadGen = ++workspaceLoadGenRef.current;
      /*
       * Same loading transition as pickProblem — do not invent a parallel path.
       * fromBrowse: browser overlay spinner → slide → checkmark → board under
       * preparing → reveal. switching: WorkspaceLoadStatus blur spinner → check.
       * User-started opens pay the spinner; remounts skip it. Boot banners
       * stay first-open only.
       */
      const userLoad = input.userLoad === true;
      const cold = userLoad && consumeSessionColdWorkspace();
      const fromBrowse = userLoad && !problem;
      const switching = userLoad && Boolean(problem);
      setWorkspaceLoadActive(userLoad);
      if (userLoad) setShellLoadActive(true);
      if (cold) setBusy("opening document…");
      setError(null);
      setDocIndexStatus("idle");
      setDocIndexError(null);
      setDocIndexMeta(null);
      setTests(null);
      setNudges([]);
      setAgentMessages([]);
      setAnnotateEntryOpen(false);
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
        setBoardPreparing(true);
      }
      if (switching) {
        setSwitchMotion("busy");
        setBoardPreparing(true);
      }

      try {
        await applyPadSyncPing(client, { emit: false }).catch(() => {});
        const docType = input.docType ?? "markdown";
        const text = input.text ?? "";
        const bytes = input.bytes ?? null;
        /*
         * Library entries keep a full copy of text sources in localStorage.
         * A multi-megabyte dump fits in a file picker and then blows the
         * quota — refuse early with a clear message rather than a blank pad.
         */
        if (
          (docType === "code" || docType === "markdown" || docType === "web") &&
          text.length > CODE_SOURCE_MAX_CHARS
        ) {
          throw new Error(
            `This file is too large to annotate here ` +
              `(${Math.round(text.length / 1000)}k characters; max about ` +
              `${Math.round(CODE_SOURCE_MAX_CHARS / 1000)}k).`,
          );
        }
        const hash = input.hash ?? (bytes ? hashBytes(bytes) : hashMarkdown(text));

        /*
         * Which set of annotations on this file — asked before anything is set.
         *
         * Ordering is the whole of this block. The session id is minted below
         * for a set that does not exist yet, and ink starts writing under that
         * id as soon as the board can take a stroke. So the question has to be
         * answered *here*, above `setAnnotateSource` and above the mint: ask it
         * any later and a two-set file would mint a third id, start collecting
         * strokes under it, and then restore an older board on top.
         *
         * A caller that already knows the set — Recent, a tab being restored,
         * the strip — passes `docId` and is never asked.
         */
        let existing: AnnotateDoc | null = null;
        if (input.docId) {
          existing = await getAnnotateDoc(input.docId);
        } else {
          const matches = listAnnotateDocsByHash(hash);
          if (matches.length === 1) {
            existing = await getAnnotateDoc(matches[0]!.id);
          } else if (matches.length > 1) {
            const choice = await askSidecarChoice(input.name, matches);
            // The reader may have moved on while the question sat there.
            if (workspaceLoadGenRef.current !== loadGen) return;
            if (choice.kind === "cancel") throw new AnnotateOpenCancelled();
            // "New annotation set" deliberately leaves `existing` null: the
            // mint below is exactly the behaviour it is asking for.
            if (choice.kind === "open") existing = await getAnnotateDoc(choice.id);
          }
        }

        /*
         * The id this session writes under, settled before the board mounts.
         *
         * `input.docId` wins even when it has no saved content — a set chosen
         * as "new" upstream arrives as an id with nothing behind it yet, and
         * minting a second one here would strand the ink the reader is about
         * to lay down under an id nothing else knows about.
         */
        const sessionDocId = input.docId ?? existing?.id ?? freshAnnotateId();

        /*
         * The bytes go in before anything is restored over them.
         *
         * Reopening from the library needs them to already be there, and a
         * write that failed — a full quota, a private window with no
         * IndexedDB — has to stop the open rather than land the reader on a
         * blank page with ink floating over nothing.
         */
        if (bytes) {
          await putDocBytes(hash, bytes);
          void pushDocBytes(client, hash, bytes);
        }

        /*
         * Say so when the file has moved on since it was last annotated.
         *
         * Without this the writer gets a blank page and no explanation, which
         * from the outside is indistinguishable from having lost their work.
         * The old set is not applied — its marks belong to lines that have
         * shifted or gone — but it is still in the library under Recent, so
         * naming it is enough to make the situation legible.
         */
        const stale = existing ? null : findStaleAnnotateDoc(input.name, hash);

        // Mount the board under the overlay / blur, but keep it invisible until
        // the document is laid out and refreshed — then crossfade.
        if (workspaceLoadGenRef.current !== loadGen) return;
        setBoardPreparing(true);
        setProblem(ANNOTATE_PROBLEM);
        setPseudocode("");
        loadedSourceRef.current = "";
        lastSavedHashRef.current = null;
        setAnnotateSource({ name: input.name, text, hash, docType, bytes });
        if (docType === "web") {
          setWebUrl(input.name);
          /*
           * A page you have not written on is one you are still browsing.
           *
           * So: live unless it carries marks. Reopening something you annotated
           * gives you the document back, because the marks are the thing you
           * came for and they only exist on the frozen copy.
           *
           * Deliberately not keyed to `userLoad` — that is load bookkeeping,
           * true or false for reasons that have nothing to do with what the
           * reader wants, and it left pages frozen on open with no way to tell
           * why. Whether a page has been marked is a fact about the page.
           */
          const neverMarked = (existing?.footnotes?.length ?? 0) === 0;
          setWebLive(isTauriRuntime() && neverMarked);
        }
        /*
         * Give this document a tab, or claim the one it arrived on.
         *
         * A page reopened from the annotate library is still a web tab — it
         * gets the saved HTML as a one-entry history, so Back is simply empty
         * rather than the tab being a different kind of thing depending on
         * which door it came through.
         */
        /*
         * The record was written before this load began, but the hash and the
         * library id are only known now — the hash is of the bytes that just
         * arrived, and whether the library already holds them is a lookup.
         * A document with neither keeps its text on the record so parking it
         * is not losing it; binary types never need to, their bytes are in
         * IndexedDB under the hash regardless.
         */
        patchTab(input.tabId, {
          // The session id, not just a saved one: the record is what
          // `sameEntity` reads, so a set that has not been written yet still
          // has to be findable by it or reopening the file would fork again.
          docId: sessionDocId,
          hash,
          docType,
          indexed: "idle",
          source: docType === "web" || existing || bytes ? null : text,
        });
        setAnnotateHeight(null);
        annotateHeightRef.current = null;

        const dark = isDarkTheme(themeId);
        const savedInk = existing ? inkOpsFrom(existing.board) : [];
        const savedElements = existing
          ? (existing.board.elements as {
              width?: number;
              customData?: { lcMdInkFrame?: boolean } | null;
            }[])
          : null;
        const savedWidth = savedElements
          ? annotateFrameWidthFromElements(savedElements)
          : null;
        /*
         * A snapshot keeps the width it was taken at.
         *
         * The capture renders the real page at `webPageWidthForViewport` and
         * serialises the result, so the DOM that comes back is laid out for
         * *that* width. Re-deriving the paper from the window on every open
         * meant reopening a page captured on a small window inside a big one
         * put the snapshot in the top-left corner of a sheet three times its
         * size, with black around it — the layout could not reflow, because it
         * had already happened. Documents have always recovered their saved
         * frame width; there was never a reason for a page not to.
         */
        const pageWidth =
          docType === "web"
            ? // A reader page reflows, so it takes the window like any document.
              // A capture does not: its layout happened at capture width, and
              // re-deriving that from the window put the snapshot in the corner
              // of a wider sheet.
              (webHtmlSourceRef.current === "reader"
                ? webPageWidthForViewport(
                    typeof window !== "undefined" ? window.innerWidth : 1280,
                  )
                : (savedWidth ??
                  webPageWidthForViewport(
                    typeof window !== "undefined" ? window.innerWidth : 1280,
                  )))
            : annotatePageWidthForOpen(
                typeof window !== "undefined" ? window.innerWidth : ANNOTATE_PAGE_W,
                savedElements ? { elements: savedElements } : null,
              );
        setAnnotatePageWidth(pageWidth);
        const skeletons = buildAnnotateTemplate(annotatePageHeight(null), dark, pageWidth);

        if (existing) {
          boardRef.current?.restoreBoard(existing.board.elements, existing.board.appState, {
            skeletons,
            ink: savedInk,
            files: existing.board.files,
            inkPalettes: existing.board.inkPalettes,
            skipFit: true,
          });
          const live = boardRef.current?.getElements() ?? [];
          boardRef.current?.setElements(
            live.map((el) => {
              const meta = (el as { customData?: { lcMdInkFrame?: boolean } }).customData;
              if (!meta?.lcMdInkFrame) return el;
              return {
                ...(el as object),
                // Keep the saved column when marks/ink already live on it.
                // Fresh or unstamped frames still take the viewport width.
                ...(savedWidth == null || docType === "web" ? { width: pageWidth } : {}),
                locked: true,
                versionNonce: Math.random() * 2 ** 31,
              };
            }),
          );
        } else {
          boardRef.current?.seedTemplate(skeletons);
        }
        /*
         * A set that has not been saved still needs an id.
         *
         * Ink and snapshots are keyed by sidecar id and both start writing long
         * before the first save, so leaving this null until then would leave
         * the opening strokes with nowhere of their own to go. Holding no
         * library slot is what makes that safe — the row appears when
         * `saveAnnotateDoc` is first called with this id.
         */
        setAnnotateDocId(sessionDocId);
        annotateDocIdRef.current = sessionDocId;
        // Owned notes get the Edit toggle; imported files never do, because
        // editing one would write over a copy of somebody else's document.
        const owned = Boolean(existing?.owned) && docType === "markdown";
        setAnnotateOwned(owned);
        /*
         * Preview by default — except for a note with nothing in it.
         *
         * Reading is what you do with a document you already have, so preview
         * is the right landing for one. A note you have just made is not a
         * document yet: there is nothing to read, and landing in preview shows
         * a blank sheet with no obvious way off it. Empty and yours means the
         * only thing you can be here to do is write.
         */
        setEditMarkdown(owned && isFreshOwnedNote(text));
        setEditBuffer(text);
        // Footnotes belong to the entry, so a fresh open of the same file gets
        // its marks back and an unrelated document starts clean.
        setAnnotateFootnotes(existing?.footnotes ?? []);
        annotateFootnotesRef.current = existing?.footnotes ?? [];
        /*
         * Marks that already were links become edges.
         *
         * A footnote that opened a coach thread, or that had a URL saved on
         * it, is a connection the reader made — it just lived on the mark
         * rather than in the graph. Lifting is a read, not a creation, and the
         * ids are derived from the endpoints, so running it on every open
         * rewrites the same rows instead of stacking copies.
         */
        if (existing?.footnotes?.length) {
          const pad: NodeRef = {
            type: docType === "web" ? "web" : "annotate",
            id: sessionDocId,
            title: existing.name,
          };
          for (const edge of footnoteEdges(pad, existing.footnotes)) {
            void putEdge(edge).catch(() => {});
          }
        }
        pendingQuoteRef.current = null;
        const resumed = restoreAgentMessages(existing?.agent ?? []);
        if (resumed.length > 0) setAgentMessages(resumed);

        annotateBaselineRef.current = {
          id: existing?.id ?? null,
          entry: existing,
        };

        boardRef.current?.applyThemeInk(themeId);
        boardRef.current?.stripCoachViz();
        lastIdsRef.current = new Set();
        await boardRef.current?.waitForTemplate();
        // Ink first — see `openWhiteboard`. The second fit below still runs
        // once the document itself has finished measuring.
        if (existing) {
          const handle = boardRef.current;
          if (handle) await restoreInk(handle, annotateDocKey(existing.id), existing.board);
        }
        await boardRef.current?.settleFitView();

        // Document must finish laying out (measure stable) before reveal.
        // PDFs can take longer than markdown; a soft timeout used to clear the
        // loading overlay while PdfDocument still showed "Opening…".
        /*
         * Failing to settle is only fatal for a file that has to be *rendered*.
         *
         * This gate exists so the board never reveals on a half-drawn PDF —
         * pages arrive one at a time, and showing the paper before they land
         * gives the reader a blank sheet to annotate. That reasoning stops at
         * the file boundary. Markdown is a string; there is no decoder, nothing
         * to stream, nothing that can be half-done. When its height failed to
         * settle it was never because the document was too big — it was because
         * whichever component was measuring it that moment had not answered yet.
         * A new note measured zero and the reporter swallowed the reading; in
         * Edit the paper is replaced by four megabytes of Monaco, which can miss
         * an eight-second window on a cold start. Both ended in the same place:
         * a spinner, then "pick a smaller file", about a note with one heading
         * in it.
         *
         * So the throw now needs `bytes` — a real file that renders. Text opens,
         * and its page grows when the measurement arrives.
         */
        let laidOut = await waitForAnnotateLaidOut(() => annotateHeightRef.current);
        if (!laidOut && bytes) {
          laidOut = await waitForAnnotateLaidOut(() => annotateHeightRef.current, 25000);
        }
        if (!laidOut && bytes) {
          throw new Error(
            "This document did not finish opening — try again, or pick a smaller file.",
          );
        }
        await boardRef.current?.settleFitView();
        if (existing?.board.appState) {
          boardRef.current?.restoreView(existing.board.appState);
        }

        {
          const board = boardRef.current;
          annotatePristineHashRef.current = board
            ? padContentFingerprint(board.getElements(), board.getInkOpCount())
            : null;
          annotatePristineMarksRef.current = footnoteRevision(annotateFootnotesRef.current);
          annotatePristineAgentRef.current = JSON.stringify(persistableAgentMessages(resumed));
        }

        // Complete the loading transition (same beats and teardown as
        // pickProblem). Do NOT arm scroll here — interactive is still false.
        if (userLoad) {
          await finishLoadingTransition(fromBrowse, switching, loadGen);
          if (workspaceLoadGenRef.current !== loadGen) return;
        }

        setBrowseMotion("idle");
        setSwitchMotion("idle");
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setWorkspaceLoadActive(false);
        setShellLoadActive(false);
        if (cold) {
          setEntering(true);
          window.setTimeout(() => setEntering(false), boardFadeMs() || 1);
        }
        setCoachOpen(false);

        // Arm AFTER interactive flips true (Excalidraw left view mode).
        // Toggle worked because it ran here; open used to arm during prepare.
        // Double-rAF: let React commit interactive=true and attach listeners
        // before we assert hand + page bounds (canvasLoading PE also clears).
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (workspaceLoadGenRef.current !== loadGen) return;
        boardRef.current?.armReadingScroll();
        await waitMs(50);
        if (workspaceLoadGenRef.current !== loadGen) return;
        boardRef.current?.armReadingScroll();
        await waitMs(200);
        if (workspaceLoadGenRef.current !== loadGen) return;
        boardRef.current?.armReadingScroll();
        await waitMs(500);
        if (workspaceLoadGenRef.current !== loadGen) return;
        boardRef.current?.armReadingScroll();

        if (stale) {
          setNotice(
            `“${input.name}” has changed since it was annotated on ` +
              `${new Date(stale.updatedAt).toLocaleDateString()} — starting a fresh set. ` +
              `The old one is still under Recent.`,
          );
        }

        /*
         * A document you opened is a document you meant to open, so it indexes
         * itself. A *page* is not: browsing is a trail of things glanced at and
         * left, and indexing every one of them fills the room's index with the
         * search results you clicked through on the way to the thing you
         * actually wanted. So the web pad asks — there is a button on the
         * address bar, and it is the reader who decides this page is worth
         * keeping.
         */
        indexInputsRef.current = {
          hash,
          name: input.name,
          docType,
          text,
          bytes,
          delayMs: docType === "pdf" ? 1200 : 0,
        };
        /*
         * A document you *opened* is one you meant to keep, so it indexes
         * itself. Two kinds are not that, and both index on request instead.
         *
         * A page is a glance. Browsing is a trail of things looked at and left,
         * and indexing all of it fills the room with the search results you
         * clicked through on the way to what you wanted.
         *
         * A note you own is a draft. There is no moment while it is being
         * written when it is worth indexing: at the moment it is created it
         * says `# Untitled` and nothing else, and every autosave after that
         * used to write a *new* index under a new hash — the old ones are
         * hash-keyed and never collected, so a minute of typing left a dozen
         * copies of a half-finished sentence in the room's index forever.
         */
        const drafting = docType === "web" || (existing?.owned === true && docType === "markdown");
        if (drafting) setDocIndexStatus("idle");
        else indexOpenDocument();
      } catch (cause) {
        if (workspaceLoadGenRef.current !== loadGen) return;
        // Declining to open something is an answer, not an error — so the
        // chrome comes down but no banner goes up, and the chip this open was
        // going to fill goes with it.
        const cancelled = cause instanceof AnnotateOpenCancelled;
        if (cancelled) closeTab(input.tabId);
        else setError(messageOf(cause));
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        setWorkspaceLoadActive(false);
        setShellLoadActive(false);
        if (fromBrowse) setBrowseMotion("idle");
        setSwitchMotion("idle");
      } finally {
        endPadOpen();
        if (workspaceLoadGenRef.current === loadGen) {
          setBusy(null);
          setWorkspaceLoadActive(false);
          setShellLoadActive(false);
        }
      }
    },
    [
      beginPadOpen,
      client,
      endPadOpen,
      finishLoadingTransition,
      openWorkspace,
      problem,
      setShellLoadActive,
      themeId,
    ],
  );

  useEffect(() => {
    const onHub = (event: Event) => {
      const detail = (event as CustomEvent<PadHubWindowDetail>).detail;
      if (!detail) return;
      if (detail.op === "close") {
        if (detail.kind === "whiteboard" && whiteboardNotebookIdRef.current === detail.id) {
          closeTab(tab.id);
        }
        if (detail.kind === "annotate" && annotateDocIdRef.current === detail.id) {
          closeTab(tab.id);
        }
        if (detail.kind === "problem") {
          const current = problemRef.current;
          if (current && !isLocalPad(current) && problemPadId(current.dataset, current.task_id) === detail.id) {
            closeTab(tab.id);
          }
        }
        return;
      }
      if (detail.kind === "problem") {
        const current = problemRef.current;
        if (!current || isLocalPad(current)) return;
        if (problemPadId(current.dataset, current.task_id) !== detail.id) return;
        padHubApplyRef.current = true;
        void loadProblem(current.task_id, { dataset: current.dataset }, {
          tabId: tab.id,
          userLoad: false,
        }).finally(() => {
          padHubApplyRef.current = false;
        });
        return;
      }
      if (detail.kind === "whiteboard" && whiteboardNotebookIdRef.current !== detail.id) return;
      if (detail.kind === "annotate" && annotateDocIdRef.current !== detail.id) return;
      padHubApplyRef.current = true;
      void (async () => {
        try {
          if (detail.kind === "whiteboard") {
            await loadWhiteboard({ notebookId: detail.id, tabId: tab.id, userLoad: false });
            return;
          }
          const doc = await getAnnotateDoc(detail.id);
          if (!doc) return;
          await loadAnnotate({
            name: doc.name,
            docType: doc.docType,
            text: doc.source,
            docId: doc.id,
            tabId: tab.id,
            userLoad: false,
          });
        } finally {
          padHubApplyRef.current = false;
        }
      })();
    };
    window.addEventListener(PAD_HUB_WINDOW_EVENT, onHub);
    return () => window.removeEventListener(PAD_HUB_WINDOW_EVENT, onHub);
  }, [closeTab, loadAnnotate, loadProblem, loadWhiteboard, tab.id]);

  /**
   * Write the annotation set out as a file the writer can keep.
   *
   * Annotations live in this browser's storage, which is fine right up until
   * the tablet is not the device they have. The sidecar is the way out.
   */
  const exportAnnotateAnnotations = useCallback(() => {
    const board = boardRef.current;
    const source = annotateSourceRef.current;
    if (!board || !source) return;
    /*
     * An owned note has no original on disk, so exporting it means two files:
     * the text, which is the note itself and the only copy that exists outside
     * this app, and the sidecar of ink over it. Imported files skip the first
     * — the reader already has the document.
     */
    if (annotateOwnedRef.current) exportMarkdownNote(source.name, source.text);
    void exportAnnotateSidecar(
      buildAnnotateSidecar({
        sourceName: source.name,
        contentHash: source.hash,
        board: board.saveBoard(),
        footnotes: annotateFootnotesRef.current,
        frameWidth: annotatePageWidthRef.current,
      }),
    ).catch((cause: unknown) => setError(messageOf(cause)));
    setNotice(
      annotateOwnedRef.current
        ? `Downloaded “${source.name}” and its annotations — look in this device’s Downloads folder.`
        : `Downloaded “${sidecarNameFor(source.name)}” — look in this device’s Downloads folder. ` +
          `Import it from the Document sheet after opening the same file.`,
    );
  }, []);

  /**
   * Read a sidecar back in, over the document it was drawn on.
   *
   * Refused when the sidecar belongs to different text: its marks were placed
   * against lines that are not the ones on screen, and putting them down anyway
   * would scatter ink across the wrong words with no way back.
   */
  const importMdInkAnnotations = useCallback(async () => {
    const source = annotateSourceRef.current;
    if (!source) {
      setError("Open a document first, then import its annotations.");
      return;
    }
    try {
      const picked = await pickSidecarFile();
      if (!picked) return;
      const sidecar = readAnnotateSidecar(picked.text);
      if (!sidecar) {
        setError(`“${picked.name}” is not an annotation sidecar.`);
        return;
      }
      if (sidecar.contentHash !== source.hash) {
        setError(
          `Those annotations were drawn over a different version of ` +
            `“${sidecar.sourceName}” — they would not line up with this text.`,
        );
        return;
      }
      const widthNote = sidecarWidthWarning(sidecar, annotatePageWidthRef.current);
      if (widthNote) setNotice(widthNote);
      const sidecarInk = inkOpsFrom(sidecar.board);
      if (sidecar.footnotes) {
        setAnnotateFootnotes(sidecar.footnotes);
        annotateFootnotesRef.current = sidecar.footnotes;
      }
      boardRef.current?.restoreBoard(sidecar.board.elements, sidecar.board.appState, {
        skeletons: buildAnnotateTemplate(
          annotatePageHeight(annotateHeight),
          isDarkTheme(themeId),
          annotateFrameWidthFromElements(
            sidecar.board.elements as {
              width?: number;
              customData?: { lcMdInkFrame?: boolean } | null;
            }[],
          ) ?? annotatePageWidth,
        ),
        ink: sidecarInk,
        files: sidecar.board.files,
        inkPalettes: sidecar.board.inkPalettes,
      });
      if (sidecarInk.length > 0) boardRef.current?.setInkOps(sidecarInk);
      setNotice(`Imported annotations for “${sidecar.sourceName}”.`);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [annotateHeight, themeId]);

  const restorePadSnapshot = useCallback(
    async (kind: "annotate" | "whiteboard", key: string, tier: PadSnapshotTier) => {
      const snap = await getPadSnapshot(kind, key, tier);
      if (!snap) {
        setError("That snapshot is no longer on this device.");
        return;
      }
      const board = boardRef.current;
      if (!board) return;
      const ink = inkOpsFrom(snap.board);
      if (kind === "annotate") {
        if (snap.footnotes) {
          setAnnotateFootnotes(snap.footnotes);
          annotateFootnotesRef.current = snap.footnotes;
        }
        if (Array.isArray(snap.agent) && snap.agent.length > 0) {
          setAgentMessages(restoreAgentMessages(snap.agent));
        }
        board.restoreBoard(snap.board.elements, snap.board.appState, {
          skeletons: buildAnnotateTemplate(
            annotatePageHeight(annotateHeight),
            isDarkTheme(themeId),
            annotateFrameWidthFromElements(
              snap.board.elements as {
                width?: number;
                customData?: { lcMdInkFrame?: boolean } | null;
              }[],
            ) ?? annotatePageWidth,
          ),
          ink,
          files: snap.board.files,
          inkPalettes: snap.board.inkPalettes,
        });
      } else {
        const pages = Math.min(
          WHITEBOARD_PAGE_LIMIT,
          Math.max(1, snap.pageCount ?? 1, countWhiteboardPages(snap.board.elements)),
        );
        board.restoreBoard(snap.board.elements, snap.board.appState, {
          skeletons: buildWhiteboardTemplate(pages, isDarkTheme(themeId)),
          ink,
          files: snap.board.files,
          inkPalettes: snap.board.inkPalettes,
        });
        setWhiteboardPageCount(pages);
        if (Array.isArray(snap.agent) && snap.agent.length > 0) {
          setAgentMessages(restoreAgentMessages(snap.agent));
        }
      }
      if (ink.length > 0) board.setInkOps(ink);
      lastSavedHashRef.current = null;
      const when = new Date(snap.writtenAt).toLocaleString();
      setNotice(`Restored the ${tier} snapshot from ${when}.`);
    },
    [annotateHeight, annotatePageWidth, themeId],
  );

  /** Pick a document from disk and open it on the pad. */
  /*
   * ---------------------------------------------------------------- opening
   *
   * Opening is two steps: write the record, then load from it. It has to be,
   * now that a workspace belongs to a tab — the chip is what the loader reads,
   * so it cannot be something the loader produces on its way out.
   *
   * `openedRecord` is what decides which chip the load lands in, and it is the
   * same call the reducer makes, so a repeat open cannot load one tab while
   * the strip focuses another.
   */
  /** Globe / address-bar opens only. Library snapshots stay annotate tabs. */
  const webTabRecord = useCallback(
    (entry: WebPadEntry): WebTab => ({
      id: newTabId("web"),
      kind: "web",
      title: webTabTitle(entry),
      dirty: false,
      lastActive: 0,
      indexed: "idle",
      entries: [entry],
      index: 0,
    }),
    [],
  );


  /*
   * Opening is writing a record, and nothing else.
   *
   * The shell parks whatever is live, focuses the new chip and mounts a
   * workspace for it, and *that* workspace loads on mount. Loading here as
   * well would open the same notebook twice — once into an instance that is
   * about to be torn down.
   */
  const openWhiteboard = useCallback(
    (opts?: { notebookId?: string | null; fresh?: boolean }) => {
      openWorkspace({
        id: newTabId("whiteboard"),
        kind: "whiteboard",
        title: "Whiteboard",
        dirty: false,
        lastActive: 0,
        // A saved notebook is the same tab wherever it is opened from; a blank
        // one has no id, so every "new notebook" really is a new tab.
        notebookId: opts?.fresh ? null : (opts?.notebookId ?? null),
      });
    },
    [openWorkspace],
  );
  openWhiteboardRef.current = (opts) => void openWhiteboard(opts);

  const openAnnotate = useCallback(
    async (input: {
      name: string;
      docType?: DocType;
      text?: string;
      bytes?: ArrayBuffer;
      docId?: string | null;
      /** Already has a record — the web paths, and any reopen from the strip. */
      tabId?: string;
    }) => {
      if (input.tabId) {
        // Already has a chip — the web paths, and any reopen from the strip.
        await loadAnnotate({ ...input, tabId: input.tabId });
        return;
      }
      const docType = input.docType ?? "markdown";
      /*
       * Library / file opens are annotate tabs, even when the sidecar is a
       * captured page. A web *tab* is only the globe / address bar path —
       * otherwise an indexed snapshot from Recent also spawned a browser chip.
       *
       * The hash has to be known here, not inside the load. It is what
       * `sameEntity` matches annotate tabs on, so a record opened without one
       * matches nothing — and opening the same document twice would grow a
       * second chip for it rather than focusing the first.
       */
      const hash = input.bytes ? hashBytes(input.bytes) : hashMarkdown(input.text ?? "");

      /*
       * Which annotation set, decided here — before a record exists.
       *
       * `sameEntity` matches annotate tabs on `docId` now, so the record has to
       * carry one from the start or opening a file twice would grow a second
       * chip for the same set. Deciding here also makes Cancel free: nothing
       * has been created yet, so declining is a `return` rather than an open
       * that has to be unwound.
       *
       * Every branch ends with a concrete id. A set that does not exist yet
       * gets a minted one — `freshAnnotateId` reserves no library slot, and the
       * alternative is ink arriving before the session has anywhere to put it.
       */
      let sidecarId = input.docId ?? null;
      if (!sidecarId) {
        const matches = listAnnotateDocsByHash(hash);
        if (matches.length === 1) {
          sidecarId = matches[0]!.id;
        } else if (matches.length > 1) {
          const choice = await askSidecarChoice(input.name, matches);
          if (choice.kind === "cancel") return;
          sidecarId = choice.kind === "open" ? choice.id : freshAnnotateId();
        } else {
          sidecarId = freshAnnotateId();
        }
      }
      /*
       * Nothing saved under this id yet — so the text has to ride the record.
       *
       * Asked of the library rather than tracked as a flag, because the same
       * answer is wanted for a minted id, for a fork of an open file, and for
       * a caller that handed us an id it had just made up. Only a set that is
       * genuinely in the library can be read back from it.
       */
      const newSet = !sidecarId || !getAnnotateDocMeta(sidecarId);

      const proposed: TabRecord = {
        id: newTabId("annotate"),
        kind: "annotate",
        title: input.name,
        dirty: false,
        lastActive: 0,
        docId: sidecarId,
        hash,
        docType,
        indexed: "idle",
        source: null,
      };
      /*
       * A document with no library entry has nowhere else to be read back
       * from, so its text rides on the record — that is what the mounting
       * workspace will load from.
       */
      if (proposed.kind === "annotate" && !input.bytes && newSet) {
        proposed.source = input.text ?? null;
      }
      openWorkspace(proposed);
    },
    [askSidecarChoice, openWorkspace],
  );

  const pickProblem = useCallback(
    (taskId: string, bank?: SearchOptions, opts?: { keepSessionNav?: boolean }) => {
      // The queue-vs-bank choice is the session's, so it is set before the
      // switch rather than carried into a workspace that has not mounted yet.
      setNavigateBySession(opts?.keepSessionNav === true);
      openWorkspace({
        id: newTabId("practice"),
        kind: "practice",
        title: titleFromSlug(taskId),
        dirty: false,
        lastActive: 0,
        dataset: bank?.dataset ?? DEFAULT_DATASET,
        taskId,
      });
    },
    [openWorkspace, setNavigateBySession],
  );

  /**
   * Write a new markdown note, in the app.
   *
   * Saved before it is opened, on purpose. Imported files deliberately wait
   * for first ink before taking a library slot — the store should not fill up
   * with every file ever glanced at — but an empty owned note *is* the
   * product, and it needs a row so Recent, the tab record and the links graph
   * all have something to name it by.
   */
  const createOwnedNote = useCallback(
    async (rawTitle: string) => {
      const title = rawTitle.trim() || "Untitled";
      const source = `# ${title}\n\n`;
      try {
        const saved = await saveAnnotateDoc({
          id: freshAnnotateId(),
          name: uniqueAnnotateName(
            title.toLowerCase().endsWith(".md") ? title : `${title}.md`,
          ),
          hash: hashMarkdown(source),
          docType: "markdown",
          owned: true,
          source,
          // A blank board with a real camera — the note is opened straight
          // after, and the open seeds the page template over this.
          board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
        });
        await openAnnotate({
          name: saved.name,
          docType: "markdown",
          text: source,
          docId: saved.id,
        });
      } catch (cause) {
        if (cause instanceof AnnotateLibraryFullError) setError(cause.message);
        else setError(messageOf(cause));
      }
    },
    [openAnnotate],
  );

  /**
   * Commit the Edit buffer into the note, and re-index it.
   *
   * The note has no disk handle to flush — `content.source` *is* the document,
   * so writing the entry is the save. The hash moves with the text, which is
   * the whole reason ink had to stop being keyed by it (step 1): the same set
   * keeps its id and its strokes across an edit that renames every byte.
   */
  const saveEditBuffer = useCallback(async (
    { reindex = false }: { reindex?: boolean } = {},
  ): Promise<boolean> => {
    const source = annotateSource;
    const id = annotateDocIdRef.current;
    if (!source || !id || !annotateOwned) return false;
    const next = editBufferRef.current;
    if (next.length > CODE_SOURCE_MAX_CHARS) {
      setError(
        `This note is too large to keep here ` +
          `(${Math.round(next.length / 1000)}k characters; max about ` +
          `${Math.round(CODE_SOURCE_MAX_CHARS / 1000)}k).`,
      );
      return false;
    }
    const hash = hashMarkdown(next);
    try {
      const saved = await saveAnnotateDoc({
        id,
        name: source.name,
        hash,
        docType: "markdown",
        owned: true,
        source: next,
        board: boardRef.current?.saveBoard({ assembleInk: false }) ?? { 
          v: 1,
          elements: [],
          appState: { scrollX: 0, scrollY: 0, zoom: 1 },
        },
        footnotes: annotateFootnotesRef.current,
        agent: persistableAgentMessages(agentMessages),
      });
      setAnnotateSource({ ...source, text: next, hash });
      void pushAnnotatePad(client, saved);
      /*
       * Re-index under the new hash so Ask answers about what the note says
       * now. The old hash's chunks are left where they are: `docs.db` is
       * hash-keyed and shared, deleting is not exposed to the client, and a
       * stale document nothing looks up again is wasted rows rather than a
       * wrong answer.
       *
       * Which is exactly why this cannot run on every save. Autosave fires
       * every second and a half of typing, and each one wrote another
       * uncollectable copy of a half-written sentence. It runs when the reader
       * puts the pen down — leaving Edit — and only for a note that is already
       * in the index, because keeping one current is a different decision from
       * putting it there. Putting it there is the chip.
       */
      if (reindex) {
        const pages = await extractDocumentPages({
          docType: "markdown",
          name: source.name,
          text: next,
        });
        if (pages.length > 0) {
          rememberExtractedPages(hash, pages);
          void client
            .putDocIndex(hash, { name: source.name, doc_type: "markdown", pages })
            .catch(() => {});
        }
      }
      /*
       * `[[Wiki]]` links, parsed here and nowhere else.
       *
       * On save rather than on keystroke because a half-typed `[[gra` names
       * nothing and would spend the interim as an unresolved node. Owned
       * markdown only: brackets in an imported textbook are its author's
       * punctuation, and reading them as links would invent edges out of
       * documents this reader never wrote.
       */
      void replaceWikiEdges(
        { type: "annotate", id, title: saved.name },
        resolveWikiLinks(next, {
          annotate: listAnnotateDocs().filter((entry) => entry.id !== id),
          whiteboards: listWhiteboardNotebooks().map((entry) => ({
            id: entry.id,
            title: entry.title,
          })),
          defaultDataset: DEFAULT_DATASET,
        }),
      ).catch(() => {});
      return true;
    } catch (cause) {
      if (cause instanceof AnnotateLibraryFullError) setError(cause.message);
      else noteStorageFull(cause);
      return false;
    }
  }, [agentMessages, annotateOwned, annotateSource, client, noteStorageFull]);

  /*
   * Autosave while Edit is open.
   *
   * The board's own autosave fingerprints the scene and the marks, and neither
   * can see a text buffer — so without this an hour of typing with no strokes
   * would sit only in memory. Debounced on the buffer rather than run on the
   * board's interval: a save rehashes the note and re-indexes it, which is not
   * something to do between keystrokes.
   */
  useEffect(() => {
    if (!editMarkdown || !annotateOwned || autosaveMs <= 0) return;
    if (editBuffer === (annotateSourceRef.current?.text ?? "")) return;
    const timer = window.setTimeout(() => void saveEditBuffer(), Math.max(autosaveMs, 1500));
    return () => window.clearTimeout(timer);
  }, [annotateOwned, autosaveMs, editBuffer, editMarkdown, saveEditBuffer]);

  /**
   * Enter or leave Edit.
   *
   * Leaving commits first: the paper re-renders from `annotateSource.text`, so
   * a buffer that had not been written back would simply vanish when the note
   * became a page again.
   */
  const toggleEditMarkdown = useCallback(() => {
    if (!annotateOwned) return;
    if (editMarkdown) {
      void saveEditBuffer({ reindex: docIndexStatus === "indexed" }).then((ok) => {
        if (!ok) {
          setError((current) => current ?? "The note could not be saved.");
        }
        setEditMarkdown(false);
      });
      return;
    }
    setEditBuffer(annotateSourceRef.current?.text ?? "");
    setEditMarkdown(true);
  }, [annotateOwned, docIndexStatus, editMarkdown, saveEditBuffer]);

  /**
   * Follow a link to whatever is on the other end.
   *
   * Each type opens the way it already opens — a problem through
   * `loadProblem` and its one board, a notebook by id, a sidecar by id. The
   * link is a pointer, so nothing here creates a second copy of anything.
   *
   * Two cases decline rather than guess: an unresolved `[[Title]]` names no
   * workspace to open, and a thread lives inside a pad, which is a hop the
   * graph page will do properly (§6) rather than something to fake here.
   */
  const openLinkedNode = useCallback(
    (node: NodeRef) => {
      if (isUnresolved(node)) {
        setNotice(`“${node.title ?? "That note"}” does not exist yet — New file will create it.`);
        return;
      }
      switch (node.type) {
        case "practice": {
          const [dataset, ...rest] = node.id.split("/");
          const taskId = rest.join("/");
          if (!dataset || !taskId) return;
          // Still one problem tab: opening replaces it, as Home Practice does.
          pickProblem(taskId, { dataset } as SearchOptions);
          return;
        }
        case "whiteboard":
          openWhiteboard({ notebookId: node.id });
          return;
        case "annotate":
        case "web": {
          const meta = getAnnotateDocMeta(node.id);
          if (!meta) {
            setError("That workspace is no longer in the library.");
            return;
          }
          void (async () => {
            const entry = await getAnnotateDoc(node.id);
            if (!entry) {
              setError("That workspace is no longer in the library.");
              return;
            }
            await openAnnotate({
              name: entry.name,
              docType: entry.docType,
              text: entry.source,
              bytes: isBinaryDocType(entry.docType)
                ? (await getDocBytes(entry.hash).catch(() => null)) ?? undefined
                : undefined,
              docId: entry.id,
            });
          })();
          return;
        }
        case "thread":
          setNotice("Open that pad to reach its thread.");
          return;
      }
    },
    [openAnnotate, openWhiteboard, pickProblem],
  );

  const openExplore = useCallback(() => {
    openWorkspace({
      id: newTabId("explore"),
      kind: "explore",
      title: "Explore",
      dirty: false,
      lastActive: 0,
    });
  }, [openWorkspace]);

  /**
   * Every workspace the libraries know about, as graph nodes.
   *
   * Read from the stores rather than from the edges, so a note written five
   * minutes ago and linked to nothing still shows up — Explore is the atlas of
   * what exists, not of what happens to be connected.
   */
  const exploreNodes = useMemo((): NodeRef[] => {
    if (tab.kind !== "explore") return [];
    const out: NodeRef[] = [];
    for (const doc of listAnnotateDocs()) {
      out.push({
        type: doc.docType === "web" ? "web" : "annotate",
        id: doc.id,
        title: annotateDocLabel(doc),
      });
    }
    for (const notebook of listWhiteboardNotebooks()) {
      out.push({ type: "whiteboard", id: notebook.id, title: notebook.title });
    }
    // Problems have no library of their own on the device — the open ones and
    // the ones something links to are what the atlas can honestly name.
    for (const open of tabsRef.current.tabs) {
      if (open.kind !== "practice") continue;
      out.push({
        type: "practice",
        id: `${open.dataset}/${open.taskId}`,
        title: open.title,
      });
    }
    return out;
  }, [tab.kind, tabsRef]);

  /** Unresolved nodes and linked problems, which no library lists. */
  const [exploreExtra, setExploreExtra] = useState<NodeRef[]>([]);
  useEffect(() => {
    if (tab.kind !== "explore") return;
    let live = true;
    void listEdges()
      .then((edges) => {
        if (!live) return;
        const known = new Set(exploreNodes.map((node) => `${node.type}:${node.id}`));
        const extra = new Map<string, NodeRef>();
        for (const edge of edges) {
          for (const end of [edge.from, edge.to]) {
            const key = `${end.type}:${end.id}`;
            if (known.has(key) || extra.has(key)) continue;
            extra.set(key, end);
          }
        }
        setExploreExtra([...extra.values()]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [exploreNodes, tab.kind]);

  const pickAndOpenAnnotate = useCallback(async () => {
    if (busy !== null) return;
    beginPadOpen();
    setShellLoadActive(true);
    setWorkspaceLoadActive(true);
    const fromBrowse = !problem;
    if (fromBrowse) {
      setHoldBrowseOverlay(true);
      setBrowseMotion("busy");
      setBoardPreparing(true);
    }
    let handedOff = false;
    try {
      const picked = await pickDocumentFile();
      if (!picked) return;
      handedOff = true;
      await openAnnotate({
        name: picked.name,
        docType: picked.docType,
        text: picked.text,
        bytes: picked.bytes,
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      endPadOpen();
      if (!handedOff) {
        setBusy(null);
        setWorkspaceLoadActive(false);
        setShellLoadActive(false);
        setBoardPreparing(false);
        if (fromBrowse) {
          setBrowseMotion("idle");
          setHoldBrowseOverlay(false);
        }
      } else {
        // Load lives on the new chip. Home must not stay preparing/busy or
        // focusing it later would keep the chooser disabled.
        setBusy(null);
        setWorkspaceLoadActive(false);
        setBoardPreparing(false);
      }
    }
  }, [beginPadOpen, busy, endPadOpen, openAnnotate, problem, setBrowseMotion, setHoldBrowseOverlay, setShellLoadActive]);

  const showWebEntry = useCallback(
    async (tab: WebTab, userLoad = false) => {
      const entry = currentEntry(tab);
      if (!entry || busyRef.current !== null) return;
      await loadAnnotate({
        name: entry.url,
        docType: "web",
        text: entry.html,
        tabId: tab.id,
        userLoad,
      });
    },
    [loadAnnotate],
  );

  /**
   * Stop browsing and keep what is on screen.
   *
   * Reads the live view's own DOM rather than fetching the address again: you
   * may have clicked three links, filled a form, or expanded something, and the
   * page you are looking at is the one you meant to write on. A re-fetch would
   * freeze a different page and call it the same one.
   */
  const freezeLivePage = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setBusy("Freezing this page…");
    try {
      const { serializeLiveWebview } = await import("./util/webPageCapture");
      const live = await serializeLiveWebview();
      const { pageFromCapturedHtml } = await import("./util/webPage");
      const page = await pageFromCapturedHtml(live.html, live.url || webUrlRef.current);
      setWebHtmlSource(page.source);
      setWebHtmlNote(page.note ?? null);
      setWebLive(false);
      setBusy(null);
      await loadAnnotate({
        name: page.url,
        docType: "web",
        text: page.html,
        tabId: tab.id,
        userLoad: true,
      });
    } catch (cause) {
      setBusy(null);
      setError(messageOf(cause));
    }
  }, [loadAnnotate, tab.id]);

  /**
   * Fetch a page, sanitise it, then open it as a web tab (globe / address bar).
   *
   * Library files that happen to be captured HTML stay annotate tabs.
   * `loadAnnotate` bails while `busy` is set, so in-place navigation clears
   * that flag first. A new tab loads on mount — this instance must not.
   */
  const openWebPage = useCallback(
    async (raw: string, opts?: { newTab?: boolean }) => {
      /*
       * A new address replaces whatever was loading. Enter-while-busy used to
       * no-op, then the in-flight Google capture painted over the typed URL.
       * Bumping the gen makes that fetch see a mismatch and bail.
       */
      beginPadOpen();
      const loadGen = ++workspaceLoadGenRef.current;
      const fromBrowse = !problem;
      setShellLoadActive(true);
      setWorkspaceLoadActive(true);
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
        setBoardPreparing(true);
      }
      setBusy("loading page…");
      setError(null);
      let handedOff = false;
      let sameWorkspace = false;
      try {
        const page = await fetchWebPage(raw);
        if (workspaceLoadGenRef.current !== loadGen) return;
        setWebHtmlSource(page.source);
        setWebHtmlNote(page.note ?? null);
        const entry = {
          url: page.url,
          title: page.title || hostLabelFromUrl(page.url),
          html: page.html,
        };
        /*
         * A page navigated to from the one on screen extends that tab's
         * history; anything else — the globe, the strip's `+`, a link opened
         * deliberately in a new tab — is a new tab, and the reducer holds the
         * cap of two.
         *
         * The new workspace loads on mount. Do not loadAnnotate here: this
         * instance is Home (or the previous pad) and would double-open.
         */
        /*
         * This pane's tab, not whichever tab has focus.
         *
         * `activeTabOf` is the wrong question in a split: each pane is its own
         * workspace, and Reload belongs to the pane whose button was pressed.
         * Asking the shell instead meant that with the *other* pane focused,
         * this one's Reload found no web tab to reuse and opened a third.
         */
        const own = tabsRef.current.tabs.find((entry) => entry.id === tab.id) ?? null;
        const current = own?.kind === "web" ? own : activeTabOf(tabsRef.current);
        const inPlace = opts?.newTab !== true && current.kind === "web" ? current : null;
        if (inPlace) {
          sameWorkspace = true;
          busyRef.current = null;
          setBusy(null);
          /*
           * `webPush` is a React dispatch — tabsRef still holds the old
           * snapshot until the next render. Show the pushed tab, not `inPlace`,
           * or loadAnnotate paints Google and setWebUrl overwrites the omnibox.
           */
          const nextTab = pushWeb(inPlace, entry);
          webPush(inPlace.id, entry);
          handedOff = true;
          await showWebEntry(nextTab, true);
        } else {
          openWorkspace(webTabRecord(entry));
          handedOff = true;
        }
      } catch (cause) {
        if (workspaceLoadGenRef.current !== loadGen) return;
        setError(messageOf(cause));
      } finally {
        endPadOpen();
        if (workspaceLoadGenRef.current !== loadGen) return;
        if (!handedOff) {
          setBusy(null);
          setWorkspaceLoadActive(false);
          setShellLoadActive(false);
          if (fromBrowse) {
            setHoldBrowseOverlay(false);
            setBrowseMotion("idle");
            setBoardPreparing(false);
          }
        } else if (!sameWorkspace) {
          setBusy(null);
          setWorkspaceLoadActive(false);
          setBoardPreparing(false);
        }
      }
    },
    [
      beginPadOpen,
      endPadOpen,
      openWorkspace,
      problem,
      setBrowseMotion,
      setHoldBrowseOverlay,
      setShellLoadActive,
      showWebEntry,
      webPush,
      webTabRecord,
    ],
  );

  const stepWebTab = useCallback(
    (delta: number) => {
      const tab = activeTabOf(tabsRef.current);
      if (tab.kind !== "web" || !canStepWeb(tab, delta) || busy !== null) return;
      webStep(tab.id, delta);
      void showWebEntry(stepWeb(tab, delta));
    },
    [busy, showWebEntry],
  );

  /** Session queue after Start / Random; otherwise the filtered problem bank. */
  const stepProblem = useCallback(
    async (delta: number) => {
      if (!problem || busy !== null) return;
      if (isLocalPad(problem)) return;
      // Queue entries are `dataset/task_id`, since the same slug can be in
      // several problem sets at once.
      const queue = session?.queue ?? [];
      const queueIndex = queue.indexOf(problem.key);
      if (navigateBySession && queue.length > 0 && queueIndex >= 0) {
        const next = queue[queueIndex + delta];
        if (next) {
          const [nextDataset, nextTask] = splitProblemKey(next);
          void pickProblem(nextTask, { ...bankFilters, dataset: nextDataset }, { keepSessionNav: true });
        }
        return;
      }
      try {
        const adjacent = await client.adjacentProblems(problem.task_id, {
          ...bankFilters,
          dataset: problem.dataset,
        });
        const next = delta < 0 ? adjacent.prev : adjacent.next;
        if (next) void pickProblem(next, { ...bankFilters, dataset: problem.dataset });
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [problem, busy, session, navigateBySession, client, bankFilters, pickProblem],
  );

  useEffect(() => {
    if (!problem || isLocalPad(problem)) {
      setCanStepPrev(false);
      setCanStepNext(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const queue = session?.queue ?? [];
      const queueIndex = queue.indexOf(problem.key);
      if (navigateBySession && queue.length > 0 && queueIndex >= 0) {
        if (!cancelled) {
          setCanStepPrev(queueIndex > 0);
          setCanStepNext(queueIndex < queue.length - 1);
        }
        return;
      }
      try {
        const adjacent = await client.adjacentProblems(problem.task_id, {
          ...bankFilters,
          dataset: problem.dataset,
        });
        if (!cancelled) {
          setCanStepPrev(Boolean(adjacent.prev));
          setCanStepNext(Boolean(adjacent.next));
        }
      } catch {
        if (!cancelled) {
          setCanStepPrev(false);
          setCanStepNext(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [problem, session, navigateBySession, bankFilters, client]);

  // The coach socket's lifecycle.
  //
  // It carries two things now: the ambient loop (still gated behind
  // `AMBIENT_ENABLED`, still on its own timer) and interactive runs. Which of
  // those is wanted decides whether the socket opens at all — with ambient off
  // and `ws_runs` off, this stays exactly as it was: no connection, no timer.
  useEffect(() => {
    if (!problem) return;
    const ambient = AMBIENT_ENABLED && mode === "ambient";
    if (!ambient && !coachFlags.ws_runs) return;
    // Named invoke carries Ask / Review. The LAN socket is 127.0.0.1:7878,
    // which the APK does not bind — opening it paints "the agent connection
    // failed" on every document.
    if (isTauriRuntime() && !ambient) return;

    const onFrame = (frame: ServerFrame) => {
      switch (frame.type) {
        case "ready":
          setAmbientProvider(frame.provider);
          break;
        case "thinking":
          setThinking(true);
          break;
        case "nudge":
          setThinking(false);
          setNudges((current) => [{ ...frame, at: Date.now() }, ...current].slice(0, 12));
          setAgentMessages((current) => [
            ...current,
            {
              id: `nudge-${Date.now()}`,
              role: "assistant",
              content: frame.nudge,
              at: Date.now(),
            },
          ]);
          setCoachOpen(true);
          break;
        case "skipped":
          setThinking(false);
          setLastSkip(frame.reason);
          break;
        case "error":
          setThinking(false);
          setError(frame.message);
          break;
      }
    };

    const coach = new AmbientCoach(
      pairing,
      {
        onFrame,
        onCapturing: () => setThinking(true),
        onOpen: () => setConnected(true),
        onClose: () => setConnected(false),
        onError: (message) => setError(message),
        onSkip: (reason) => setLastSkip(reason),
      },
      defaultCoachSocketFactory,
    );
    coachRef.current = coach;
    if (ambient) coach.start(problem.task_id, probe, capture);
    else coach.connect(problem.task_id);

    return () => {
      coach.stop();
      coachRef.current = null;
      setConnected(false);
      setThinking(false);
    };
  }, [mode, problem, pairing, probe, capture, coachFlags.ws_runs]);

  /**
   * Open an assistant turn to fill in while the coach works.
   *
   * The turn exists from the moment the request leaves, so the stages have
   * somewhere to land and the student can see the work is theirs — not a
   * spinner that could belong to anything.
   */
  const beginCoachTurn = useCallback(
    (replyTo?: CoachReplyRef, pendingAck?: CoachPendingAck): string => {
    const id = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    activeCoachTurnIdRef.current = id;
    dirtyRef.current = true;
    setAgentMessages((current) => [
      ...current,
      {
        id,
        role: "assistant",
        content: "",
        at: Date.now(),
        pending: true,
        processEvents: [],
        ...(pendingAck ? { pendingAck } : {}),
        ...(replyTo ? { replyTo } : {}),
      },
    ]);
    return id;
  },
  []);

  const appendProcessEvent = useCallback((messageId: string, event: CoachProcessEvent) => {
    setAgentMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, processEvents: [...(message.processEvents ?? []), event] }
          : message,
      ),
    );
  }, []);

  const appendReasoning = useCallback((messageId: string, chunk: string) => {
    const text = chunk.trim();
    if (!text) return;
    setAgentMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) return message;
        const prior = message.reasoning?.trim() ?? "";
        if (prior === text || prior.endsWith(text)) return message;
        return {
          ...message,
          reasoning: prior ? `${prior}\n\n${text}` : text,
        };
      }),
    );
  }, []);

  /**
   * Finish a placeholder turn.
   *
   * `produced` replaces it in place, keeping its position in the thread — one
   * message for a review or an answer, several when Draw returns more than one
   * diagram. `null` drops it: the failure is already on the error banner, and
   * an empty turn left behind would read as the coach answering with nothing.
   */
  const finishCoachTurn = useCallback(
    (
      messageId: string,
      produced: Array<Partial<AgentChatMessage> & { content: string }> | null,
    ) => {
      setAgentMessages((current) => {
        const index = current.findIndex((message) => message.id === messageId);
        if (index < 0) return current;
        const placeholder = current[index];
        const rest = [...current.slice(0, index), ...current.slice(index + 1)];
        if (!produced || produced.length === 0) return rest;

        const built: AgentChatMessage[] = produced.map((part, offset) => ({
          id: offset === 0 ? placeholder.id : `${placeholder.id}-${offset}`,
          role: "assistant",
          at: Date.now(),
          ...(placeholder.replyTo ? { replyTo: placeholder.replyTo } : {}),
          ...(offset === 0
            ? {
                processEvents: placeholder.processEvents,
                ...(placeholder.reasoning ? { reasoning: placeholder.reasoning } : {}),
              }
            : {}),
          ...part,
        }));
        const next = [...current.slice(0, index), ...built, ...current.slice(index + 1)];
        return built.some((message) => message.drawing?.expanded)
          ? enforceVisibleDrawingCap(next, MAX_VISIBLE_DRAWINGS)
          : next;
      });
    },
    [],
  );

  /**
   * Run one coach job, over the socket when it is available and blocking HTTP
   * when it is not.
   *
   * The payloads are identical either way — the daemon's `run` frame takes the
   * same body its `POST /coach/*` route does — so `http` is a straight
   * fallback, not a second code path with its own quirks.
   */
  const runCoachJob = useCallback(
    async <T,>(
      action: RunAction,
      payload: Record<string, unknown>,
      messageId: string | null,
      http: () => Promise<T>,
    ): Promise<T> => {
      const socket = coachRef.current;
      if (!coachFlags.ws_runs || !socket) return http();
      try {
        return await socket.run<T>(action, payload, {
          onProcess: (event) => {
            if (messageId && coachFlags.process_events_ui) appendProcessEvent(messageId, event);
          },
          onReasoning: (text) => {
            if (messageId) appendReasoning(messageId, text);
          },
        });
      } catch (cause) {
        // A daemon that predates run frames, or a socket that dropped, should
        // cost the student a retry at worst — not the answer.
        if (isSocketRunUnavailable(cause)) return http();
        throw cause;
      }
    },
    [coachFlags.ws_runs, coachFlags.process_events_ui, appendProcessEvent, appendReasoning],
  );

  const pushCoachMessage = useCallback(
    (
      role: AgentChatMessage["role"],
      content: string,
      extra?: Pick<
        AgentChatMessage,
        | "review"
        | "attachments"
        | "drawing"
        | "bridge"
        | "bridgePending"
        | "bridgeError"
        | "flags"
        | "replyTo"
        | "queued"
      >,
    ) => {
      dirtyRef.current = true;
      // Minted here rather than inside the updater: callers need the id to
      // hang things off the turn (a document footnote, for one), and an
      // updater can be re-run by React without meaning a second message.
      const id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setAgentMessages((current) => {
        let next: AgentChatMessage[] = [
          ...current,
          {
            id,
            role,
            content,
            at: Date.now(),
            ...extra,
          },
        ];
        if (extra?.drawing?.expanded) {
          next = enforceVisibleDrawingCap(next, MAX_VISIBLE_DRAWINGS);
        }
        return next;
      });
      return id;
    },
    [],
  );

  const submitForReview = useCallback(async (
    studentNote?: string,
    includeBoard = true,
    attachments?: AgentChatMessage["attachments"],
    /** Lazy composer: review the board only — code dock is filled separately. */
    layoutOnly = false,
    threadAnchor?: CoachReplyRef | null,
    pendingAck?: CoachPendingAck,
  ) => {
    const board = boardRef.current;
    if (!board || !problem) return;
    const genAtStart = coachRunGenRef.current;
    setBusy("asking the agent…");
    setError(null);
    setNotice(null);
    if (!suppressCoachPanelOpenRef.current) setCoachOpen(true);

    const note = studentNote?.trim() ?? "";
    const topic =
      note.length > 0
        ? note.length > 48
          ? `${note.slice(0, 48)}…`
          : note
        : includeBoard
          ? "your board"
          : "your question";
    // Timed guesses at the phases, for the path that has nothing better. When
    // runs go over the socket the real stage boundaries arrive instead, and
    // guessing over the top of them would contradict them.
    const phaseTimers: number[] = [];
    if (!coachFlags.ws_runs) {
      const phases = includeBoard
        ? [
            note ? "Reading your message…" : "Reading the request…",
            "Loading your layouts…",
            `Thinking about ${topic}…`,
            "Preparing response…",
          ]
        : ["Reading your message…", `Thinking about ${topic}…`, "Preparing response…"];
      let delay = 0;
      for (const label of phases) {
        const id = window.setTimeout(() => setCoachPhase(label), delay);
        phaseTimers.push(id);
        delay += label.startsWith("Thinking") ? 2200 : 900;
      }
      setCoachPhase(phases[0]);
    } else {
      setCoachPhase(`Thinking about ${topic}…`);
    }

    const turnId = beginCoachTurn(threadAnchor ?? undefined, pendingAck);
    let finished = false;
    let failText: string | null = null;
    try {
      await syncSolution();
      const askedNote = note
        ? withConversationContext(note, agentMessagesRef.current, {
            threadRootId: threadAnchor?.id ?? null,
          })
        : note;
      let payload;
      let capturedIds: Set<string> | null = null;
      if (includeBoard) {
        const snapshot = await buildSnapshot(board, recognizerRef.current, {
          pseudocode: pseudocodeRef.current,
          previousIds: lastReviewIdsRef.current,
          turnIndex: reviewTurnRef.current,
          includePng: modeHasVision("review"),
          structureBaseline: lastStructureBaselineRef.current,
          skeletonHash: await sha256Hex(skeletonOf(pseudocodeRef.current)),
          lastSkeletonHash: lastSkeletonHashRef.current,
          lastPseudocodeHash: lastPseudocodeHashRef.current,
        });
        if (note) {
          snapshot.board.recognized_text = `Student asks:\n${askedNote}\n\n${snapshot.board.recognized_text ?? ""}`;
        }
        // Recognized text is not the only evidence of work: shapes, stamps, pen
        // ink, and (with a vision model) a PNG of the handwriting all count.
        const drawn =
          studentAuthoredElements(board.getElements()).length > 0 || board.hasRasterInk();
        const legible =
          snapshot.board.recognized_text.trim().length > 0 || pseudocodeRef.current.trim().length > 0;
        const pictured = snapshot.hasHandwriting && Boolean(snapshot.board.png);
        if (!legible && !drawn && !pictured) {
          failText = "nothing on the board yet — sketch or type an approach, then ask the agent";
          setError(failText);
          return;
        }
        if (!legible && !pictured && recognizerRef.current.name === "none") {
          setNotice(
            "handwriting isn't recognized in the browser build — sending the shapes and layout you drew; type with the text tool if the agent misreads you",
          );
        }
        payload = snapshot.board;
        capturedIds = snapshot.ids;
      } else {
        if (!note) {
          failText = "type a question, or turn on Review";
          setError(failText);
          return;
        }
        payload = {
          recognized_text: `Student asks:\n${askedNote}`,
          pseudocode: pseudocodeRef.current.trim() || undefined,
          turn_index: reviewTurnRef.current,
        };
      }
      // `POST /coach/review` flattens the board into the request body, so the
      // run payload does the same — the daemon reads one struct either way.
      const askForReview = (board: typeof payload) =>
        runCoachJob<ReviewResponse>(
          "review",
          {
            task_id: problem.task_id,
            dataset: problem.dataset,
            layout_only: layoutOnly,
            ...board,
            app_messages: appMessages(),
          },
          turnId,
          () =>
            client.review(
              problem.task_id,
              { ...board, app_messages: appMessages() },
              problem.dataset,
              { layoutOnly },
            ),
        );

      let result: ReviewResponse;
      try {
        result = await askForReview(payload);
      } catch (cause) {
        // The picture is the first thing to give up: a board too big to buffer,
        // or a local VLM that hangs on the PNG, must not cost the whole review.
        const hasPng = "png" in payload && Boolean(payload.png);
        if (!hasPng || (!isBodyLimitError(cause) && !isLlmTimeoutError(cause))) throw cause;
        const { png: _png, ...withoutPng } = payload;
        result = await askForReview(withoutPng);
        setNotice(
          isLlmTimeoutError(cause)
            ? "the board image timed out at the model — the agent reviewed your text and layout without it"
            : "the board image was too large to send — the agent reviewed your text and layout without it",
        );
      }
      // One structured card in the thread — do not also push a prose duplicate.
      // Attachments show what the coach saw (same layouts as the user turn).
      if (coachRunGenRef.current !== genAtStart) return;
      finished = true;
      finishCoachTurn(turnId, [
        {
          content: "",
          review: result,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
      ]);
      // Baseline advances only on success — a failed review must not consume it.
      if (capturedIds) {
        lastReviewIdsRef.current = capturedIds;
        reviewTurnRef.current += 1;
        lastStructureBaselineRef.current = structureBaselineFromBoard(board.getElements());
        lastPseudocodeHashRef.current = await sha256Hex(pseudocodeRef.current);
        lastSkeletonHashRef.current = await sha256Hex(skeletonOf(pseudocodeRef.current));
      }
    } catch (cause) {
      failText = messageOf(cause);
      if (coachRunGenRef.current === genAtStart) setError(failText);
    } finally {
      if (coachRunGenRef.current !== genAtStart) {
        if (activeCoachTurnIdRef.current === turnId) activeCoachTurnIdRef.current = null;
        return;
      }
      // Every early return above — an empty board, a missing question — lands
      // here too, and none of them should leave a turn waiting forever.
      if (!finished) finishCoachTurn(turnId, coachFailureTurns(failText));
      for (const id of phaseTimers) window.clearTimeout(id);
      setCoachPhase(null);
      setBusy(null);
      if (activeCoachTurnIdRef.current === turnId) activeCoachTurnIdRef.current = null;
      if (coachSendDepthRef.current === 0) drainCoachSendQueueRef.current();
    }
  }, [
    client,
    problem,
    syncSolution,
    modeHasVision,
    appMessages,
    coachFlags.ws_runs,
    beginCoachTurn,
    finishCoachTurn,
    runCoachJob,
  ]);

  /**
   * Look at each diagram after the board rendered it, and take one correction.
   *
   * This runs *after* the turn is finished, deliberately: the diagram the
   * student asked for is already on the board and already theirs to read. The
   * check is an improvement pass, so a slow or failing one must not hold up
   * what already works.
   */
  const reviewDrawings = useCallback(
    async (drawables: VizProgram[], ask: string) => {
      const board = boardRef.current;
      if (!board || !problem || !coachFlags.draw_review_enabled) return;
      for (const program of drawables) {
        try {
          const png = await board.exportVizPng(program.id);
          // No pixels means the group is not on the board — collapsed, capped
          // out, or replaced. Nothing to look at.
          if (!png) continue;
          const verdict = await runCoachJob<DrawReviewEnvelope>(
            "draw_review",
            { task_id: problem.task_id, dataset: problem.dataset, program, png, ask },
            null,
            () => client.drawReview(problem.task_id, program, png, ask, problem.dataset),
          );
          const fixed = verdict.program ? parseVizProgram(verdict.program) : null;
          if (!fixed) continue;
          // The replacement keeps the program id, so it lands on top of the
          // diagram it is fixing rather than beside it.
          setAgentMessages((current) => {
            const next = current.map((message) =>
              message.drawing?.program.id === fixed.id
                ? { ...message, drawing: { ...message.drawing, program: fixed, frameIndex: 0 } }
                : message,
            );
            queueMicrotask(() => syncDrawingsToBoard(next));
            return next;
          });
          pushCoachMessage(
            "assistant",
            `Redrew that diagram — ${verdict.issues[0] ?? verdict.fix_hint}`,
          );
        } catch {
          // Best-effort by design: the diagram on the board already passed the
          // schema gate, which is the check with teeth.
        }
      }
    },
    [
      client,
      problem,
      coachFlags.draw_review_enabled,
      runCoachJob,
      syncDrawingsToBoard,
      pushCoachMessage,
    ],
  );

  const askForDiagram = useCallback(async (ask = "", threadAnchor?: CoachReplyRef | null) => {
    const board = boardRef.current;
    if (!board || !problem) return;
    const genAtStart = coachRunGenRef.current;
    setBusy("drawing…");
    setError(null);
    if (!suppressCoachPanelOpenRef.current) setCoachOpen(true);
    const turnId = beginCoachTurn(threadAnchor ?? undefined, {
      flags: ["Draw"],
      hasQuestion: Boolean(ask.trim()),
      boardAttached: true,
      photoCount: 0,
    });
    let finished = false;
    let failText: string | null = null;
    try {
      await syncSolution();
      const contextualAsk = withConversationContext(ask, agentMessagesRef.current, {
        threadRootId: threadAnchor?.id ?? null,
      });
      const snapshot = await buildSnapshot(board, recognizerRef.current, {
        pseudocode: pseudocodeRef.current,
        includePng: modeHasVision("viz"),
      });
      const vizBoard = { ...snapshot.board, app_messages: appMessages() };
      const envelope = await runCoachJob<VizEnvelope>(
        "viz",
        { task_id: problem.task_id, dataset: problem.dataset, board: vizBoard, ask: contextualAsk },
        turnId,
        () => client.viz(problem.task_id, vizBoard, contextualAsk, problem.dataset),
      );
      const drawables = envelope.programs
        .map(parseVizProgram)
        .filter((candidate): candidate is VizProgram => candidate !== null)
        .slice(0, MAX_VISIBLE_DRAWINGS);

      if (drawables.length > 0) {
        dirtyRef.current = true;
        // Coach ink lives on the agent page — jump there on mobile so drawings
        // aren't parked invisible on Walkthrough / Scratch.
        if (mobile) setActiveRegion("agent");
        finished = true;
        finishCoachTurn(
          turnId,
          drawables.map((drawable, index) => ({
            content:
              drawables.length === 1
                ? "Drew a diagram on the board."
                : `Drew diagram ${index + 1} of ${drawables.length} on the board.`,
            drawing: withNewDrawing(drawable),
          })),
        );
        setAgentMessages((current) => {
          queueMicrotask(() => syncDrawingsToBoard(current));
          return current;
        });
        void reviewDrawings(drawables, contextualAsk);
      }

      if (coachRunGenRef.current !== genAtStart) return;

      const api = sceneApi();

      for (const annotation of envelope.annotations ?? []) {
        if (!api) break;
        applyAnnotation(api, (skeletons) => board.convert(skeletons), annotation, renderAnnotation);
      }

      for (const [index, highlight] of (envelope.highlights ?? []).entries()) {
        if (!api) break;
        applyHighlight(
          api,
          (skeletons) => board.convert(skeletons),
          highlight,
          index,
          (hl, elements, i) =>
            renderHighlight(hl, elements as import("./canvas/capture").SceneElementLike[], i),
        );
      }

      for (const citation of envelope.citations ?? []) {
        pushCoachMessage(
          "assistant",
          `Case ${citation.case_number}:\n${citation.input.trim()}\n→ ${citation.expected.trim()}\n\n${citation.why}`,
          threadAnchor ? { replyTo: threadAnchor } : undefined,
        );
      }

      for (const reason of envelope.rejected ?? []) {
        pushCoachMessage("assistant", reason, threadAnchor ? { replyTo: threadAnchor } : undefined);
      }

      if (
        drawables.length === 0 &&
        (envelope.annotations?.length ?? 0) === 0 &&
        (envelope.citations?.length ?? 0) === 0 &&
        (envelope.highlights?.length ?? 0) === 0
      ) {
        if (envelope.message?.trim()) {
          finished = true;
          finishCoachTurn(turnId, [{ content: envelope.message.trim() }]);
        } else {
          failText =
            envelope.rejected?.[0] ??
            "the agent didn't produce a diagram — its model may not support tool calling";
          setError(failText);
        }
      }
    } catch (cause) {
      failText = messageOf(cause);
      if (coachRunGenRef.current === genAtStart) setError(failText);
    } finally {
      if (coachRunGenRef.current !== genAtStart) {
        if (activeCoachTurnIdRef.current === turnId) activeCoachTurnIdRef.current = null;
        return;
      }
      if (!finished) finishCoachTurn(turnId, coachFailureTurns(failText));
      setBusy(null);
      if (activeCoachTurnIdRef.current === turnId) activeCoachTurnIdRef.current = null;
      if (coachSendDepthRef.current === 0) drainCoachSendQueueRef.current();
    }
  }, [
    client,
    problem,
    syncSolution,
    modeHasVision,
    sceneApi,
    appMessages,
    syncDrawingsToBoard,
    mobile,
    beginCoachTurn,
    finishCoachTurn,
    runCoachJob,
    pushCoachMessage,
    reviewDrawings,
  ]);

  const applyFilledCode = useCallback(
    async (filled: string, note: string, threadAnchor?: CoachReplyRef | null) => {
      if (!problem) return;
      /*
       * Repair the import the model forgot before it reaches the editor.
       *
       * Models answer these in the 3.5 idiom — `List[int]` — because that is
       * what the training data looks like, and often omit the import. On 3.12
       * that is `NameError` at import time: the tests do not fail, they never
       * start. The prompt asks for builtin generics; this is the net under it.
       */
      const next = ensureTypingImports(filled.trim());
      if (!next) return;
      setPseudocode(next);
      pseudocodeRef.current = next;
      dirtyRef.current = true;
      try {
        await client.putSolution(problem.task_id, next, problem.dataset);
        setNotice(note.trim() || "Lazy fill applied to solution.py");
        pushCoachMessage(
          "assistant",
          note.trim() || "Filled the parts your board already justified.",
          threadAnchor ? { replyTo: threadAnchor } : undefined,
        );
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, problem, pushCoachMessage],
  );

  const applyProposedAnnotations = useCallback((proposed: ProposedAnnotation[]) => {
    if (proposed.length === 0) return;
    const source = annotateSourceRef.current;
    const hash = source?.hash ?? "";
    setAnnotateFootnotes((current) => {
      let next = current;
      for (const ann of proposed) {
        const excerpt = (ann.excerpt ?? "").trim();
        const note = (ann.note ?? "").trim();
        if (!excerpt && !note) continue;
        const page = ann.page ?? pdfNavRef.current?.current ?? 1;
        const pages = hash ? extractedPagesFor(hash) : null;
        const pageEntry = pages?.find((entry) => entry.page === page) ?? pages?.[0];
        const pageText = pageEntry?.text ?? "";
        const needle = excerpt.slice(0, 80);
        const idx = needle && pageText ? pageText.indexOf(needle) : -1;
        const scope = pageEntry?.scope;
        const anchor: DocAnchor =
          idx >= 0
            ? {
                kind: "text",
                start: idx,
                end: idx + needle.length,
                ...(scope ? { scope } : {}),
              }
            : {
                kind: "region",
                x: 8,
                y: 8,
                w: 36,
                h: 20,
                ...(scope ? { scope } : {}),
              };
        const links = (ann.links ?? [])
          .map((url) => url.trim())
          .filter(Boolean)
          .map((url) => ({ url }));
        const notes = note
          ? [
              {
                id: freshNoteId(next.flatMap((entry) => entry.notes ?? [])),
                text: note,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ]
          : undefined;
        next = addFootnote(next, {
          id: freshFootnoteId(next),
          kind: "ai",
          anchor,
          excerpt: excerpt || note.slice(0, 80),
          createdAt: Date.now(),
          ...(notes ? { notes } : {}),
          ...(links.length > 0 ? { userLinks: links } : {}),
          ...footnoteThemeSeed(next.length),
        });
      }
      return next;
    });
  }, []);

  const askAgent = useCallback(
    async (
      question: string,
      threadAnchor?: CoachReplyRef | null,
      photos?: CoachAttachment[],
      pendingAck?: CoachPendingAck,
      docAsk?: { preset?: string | null; highlight?: string; reasoning?: AgentReasoningLevel },
    ) => {
      const note = question.trim();
      if (!problem || !note) {
        setError("type a question, or turn on Ask");
        return;
      }
      const genAtStart = coachRunGenRef.current;
      setBusy("asking…");
      setError(null);
      setNotice(null);
      if (!suppressCoachPanelOpenRef.current) setCoachOpen(true);
      setCoachPhase("Thinking…");
      const turnId = beginCoachTurn(threadAnchor ?? undefined, pendingAck);
      let finished = false;
      let failText: string | null = null;
      try {
        await syncSolution();
        /*
         * Carry the conversation into the prompt.
         *
         * `/coach/ask` builds from the problem, the code and the question, so
         * without this every turn arrives as the first one — which is why a
         * shorthand reference to something two answers ago used to be answered
         * as if it had never been said. The transcript is assembled from the
         * turns already on screen, and from inside a thread it is that thread's
         * turns rather than the whole room.
         */
        const asked = withConversationContext(note, agentMessagesRef.current, {
          threadRootId: threadAnchor?.id ?? null,
          budget: Math.max(
            400,
            (isLocalPad(problem) ? PAD_ASK_CLIP_CHARS : PROBLEM_ASK_CLIP_CHARS) -
              note.length -
              40,
          ),
        });
        // Attached photos ride the same payload on both transports — the WS
        // run frame and POST /coach/ask deserialize the one AskRequest.
        const images = (photos ?? []).map((photo) => photo.png);
        const surface = askSurface(problem);
        const source = annotateSourceRef.current;
        const docExtras =
          surface === "annotate" && source
            ? {
                document_hash: source.hash,
                page: pdfNavRef.current?.current ?? 1,
                ...(docAsk?.highlight ? { highlight: docAsk.highlight } : {}),
                page_text: pageTextForAsk(source.hash, pdfNavRef.current?.current ?? 1),
                marks_prose: packFootnoteContext(
                  attachedFootnoteIdsRef.current.flatMap((id) => {
                    const mark = annotateFootnotesRef.current.find((entry) => entry.id === id);
                    return mark ? [mark] : [];
                  }),
                ),
                ...(docAsk?.preset ? { preset: docAsk.preset } : {}),
              }
            : {};
        const askPayload =
          surface === "problem"
            ? {
                surface,
                task_id: problem.task_id,
                dataset: problem.dataset,
                question: asked,
                ...(images.length > 0 ? { images } : {}),
                ...reasoningAskFields(docAsk?.reasoning ?? "off"),
              }
            : {
                surface,
                task_id: problem.task_id,
                question: asked,
                ...(images.length > 0 ? { images } : {}),
                ...docExtras,
                ...reasoningAskFields(docAsk?.reasoning ?? "off"),
              };
        const result = await runCoachJob<{
          reply: string;
          reasoning?: string;
          proposed_annotations?: ProposedAnnotation[];
          process_events?: Array<{
            kind: string;
            label: string;
            detail?: string;
            status?: string;
            ts: number;
          }>;
        }>(
          "ask",
          askPayload,
          turnId,
          () =>
            client.ask(asked, {
              surface,
              task_id: problem.task_id,
              ...(surface === "problem" ? { dataset: problem.dataset } : {}),
              ...(images.length > 0 ? { images } : {}),
              ...docExtras,
              ...reasoningAskFields(docAsk?.reasoning ?? "off"),
            }),
        );
        if (coachRunGenRef.current !== genAtStart) return;
        finished = true;
        const reply = (result.reply ?? "").trim();
        for (const ev of result.process_events ?? []) {
          if (ev.kind === "reasoning" || ev.label === "reasoning") {
            appendReasoning(turnId, ev.detail ?? "");
            continue;
          }
          const status =
            ev.status === "proposed" || ev.status === "accepted" || ev.status === "rejected"
              ? ev.status
              : undefined;
          appendProcessEvent(turnId, {
            kind: ev.kind === "tool" ? "tool" : "stage",
            label: ev.label,
            detail: ev.detail,
            status,
            ts: ev.ts,
          });
        }
        finishCoachTurn(turnId, [
          {
            content: reply || "The model returned an empty reply.",
            ...(result.reasoning?.trim() ? { reasoning: result.reasoning.trim() } : {}),
          },
        ]);
        applyProposedAnnotations(result.proposed_annotations ?? []);
      } catch (cause) {
        failText = messageOf(cause);
        if (coachRunGenRef.current === genAtStart) setError(failText);
      } finally {
        if (coachRunGenRef.current !== genAtStart) {
          if (activeCoachTurnIdRef.current === turnId) activeCoachTurnIdRef.current = null;
          suppressCoachPanelOpenRef.current = false;
          return;
        }
        if (!finished) {
          finishCoachTurn(turnId, coachFailureTurns(failText));
        }
        setCoachPhase(null);
        setBusy(null);
        if (activeCoachTurnIdRef.current === turnId) activeCoachTurnIdRef.current = null;
        suppressCoachPanelOpenRef.current = false;
        if (coachSendDepthRef.current === 0) drainCoachSendQueueRef.current();
      }
    },
    [applyProposedAnnotations, client, problem, syncSolution, beginCoachTurn, finishCoachTurn, runCoachJob, appendProcessEvent, appendReasoning],
  );

  /** `runTests` fires this and is defined above it — see the auto-forward. */
  const askAgentRef = useRef<
    | ((
        question: string,
        threadAnchor?: CoachReplyRef | null,
        photos?: CoachAttachment[],
      ) => Promise<void>)
    | null
  >(null);
  askAgentRef.current = askAgent;

  const normalizeCoachFlags = useCallback(
    (requestedFlags: AgentSendFlags): AgentSendFlags =>
      isLocalPad(problem)
        ? {
            ask: true,
            draw: false,
            reviewBoard: false,
            lazy: false,
            handwriting: requestedFlags.handwriting,
            annotations: requestedFlags.annotations,
            reasoning: requestedFlags.reasoning,
            ...(requestedFlags.photos ? { photos: requestedFlags.photos } : {}),
            ...(requestedFlags.pageQuote ? { pageQuote: requestedFlags.pageQuote } : {}),
            ...(requestedFlags.replyTo ? { replyTo: requestedFlags.replyTo } : {}),
            ...(requestedFlags.threadRootId != null
              ? { threadRootId: requestedFlags.threadRootId }
              : {}),
            ...(requestedFlags.askPreset ? { askPreset: requestedFlags.askPreset } : {}),
          }
        : requestedFlags,
    [problem],
  );

  const flagBitsFor = (flags: AgentSendFlags): string[] =>
    [
      flags.ask ? "Ask" : null,
      flags.handwriting ? "Handwriting" : null,
      flags.annotations ? "Annotations" : null,
      flags.reasoning !== "off" ? `Reasoning · ${flags.reasoning}` : null,
      flags.reviewBoard ? "Review" : null,
      flags.draw ? "Draw" : null,
      flags.lazy ? "Lazy" : null,
      flags.photos?.length
        ? `${flags.photos.length} photo${flags.photos.length === 1 ? "" : "s"}`
        : null,
    ].filter((bit): bit is string => Boolean(bit));

  const prepareCoachSend = useCallback(
    async (text: string, flags: AgentSendFlags) => {
      const anchorId = flags.threadRootId ?? flags.replyTo?.id ?? null;
      const threadAnchor = anchorId
        ? threadAnchorRef(agentMessagesRef.current, anchorId) ?? flags.replyTo ?? null
        : null;
      const flagBits = flagBitsFor(flags);
      const photos = flags.photos ?? [];
      const quotedExcerpt = flags.pageQuote ? replyExcerpt(flags.pageQuote) : "";
      let attachments: AgentChatMessage["attachments"] =
        photos.length > 0 ? [...photos] : undefined;

      /*
       * Marks queued on the page, resolved before anything else needs to know
       * how wide this send reaches. Taken from the ref: the queue was filled by
       * a panel that has since closed, and this runs after that render.
       */
      const marks = flags.annotations
        ? attachedFootnoteIdsRef.current
            .map((id) => annotateFootnotesRef.current.find((entry) => entry.id === id))
            .filter((entry): entry is DocFootnote => Boolean(entry))
        : [];

      const codeShot = (() => {
        const board = boardRef.current;
        if (!board) return null;
        const ops = inkOpsFrom(board.saveBoard());
        if (ops.length === 0) return null;
        const frame = board
          .getElements()
          .find(
            (el) =>
              (el as { customData?: { lcRegion?: string; lcRegionFrame?: boolean } }).customData
                ?.lcRegion === "code" &&
              (el as { customData?: { lcRegionFrame?: boolean } }).customData?.lcRegionFrame,
          ) as { x?: number; y?: number; width?: number; height?: number } | undefined;
        if (!frame || typeof frame.x !== "number" || typeof frame.y !== "number") {
          return null;
        }
        const box = {
          minX: frame.x,
          minY: frame.y,
          maxX: frame.x + (frame.width ?? 0),
          maxY: frame.y + (frame.height ?? 0),
        };
        if (!hasCodeAnnotations(ops, box)) return null;
        const theme =
          BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];
        const png = renderAnnotatedCode({
          source: pseudocodeRef.current,
          ops,
          box,
          background: theme.background,
          textColor: isDarkTheme(themeId) ? "#e6edf3" : "#1b1f24",
          fontScene: statementLinePitch(readingSize) * 0.55,
        });
        return png ? { label: "Annotated code", png } : null;
      })();

      const wantsBoard =
        flags.reviewBoard ||
        flags.lazy ||
        flags.handwriting ||
        // Annotations with marks on it is a question about those passages; the
        // mark text is the attachment, and a crop of the page would only be the
        // same words again, blurrier.
        (flags.annotations && marks.length === 0);
      if (wantsBoard && boardRef.current) {
        try {
          /*
           * Annotations on its own is the narrow send: the crop in front of the
           * writer. Handwriting (or a pipeline flag) means every page carrying
           * their marks, backdrop composited under the ink.
           */
          const narrow =
            flags.annotations &&
            !flags.handwriting &&
            !flags.reviewBoard &&
            !flags.lazy;
          const board = boardRef.current;
          /*
           * Bounded, and loud when it fails.
           *
           * A canvas export that never settles used to take the whole send
           * with it — the composer sat on "Working…" before a frame had even
           * been written, which is indistinguishable from the coach hanging.
           * And the bare `catch` meant an export that threw sent the question
           * with no pictures at all and said nothing about it.
           */
          const exported = await withTimeout(
            narrow
              ? board
                  .exportViewThumb()
                  .then((thumb) => (thumb ? [thumb] : []))
              : board.exportRegionThumbs(),
            THUMB_EXPORT_TIMEOUT_MS,
            "the board export took too long",
          );
          const thumbs: Array<{ label: string; png: string }> = exported;
          if (thumbs.length > 0) {
            attachments = [
              ...(attachments ?? []),
              ...thumbs.map((thumb) => ({ label: thumb.label, png: thumb.png })),
            ];
          } else {
            setNotice("nothing on the board to attach — sending the question on its own");
          }
        } catch (cause) {
          // Best-effort still, but not silent: the question goes without the
          // pictures and the writer is told which half arrived.
          setNotice(`could not attach the board (${messageOf(cause)}) — sending the question alone`);
        }
      }
      if (
        codeShot &&
        (flags.handwriting || flags.annotations || flags.reviewBoard || flags.lazy)
      ) {
        attachments = [...(attachments ?? []), codeShot];
      }

      const bubble = text || (quotedExcerpt ? `“${quotedExcerpt}”` : "Send");
      const quotedPassage = flags.pageQuote?.trim();
      const askedRaw = flags.replyTo
        ? `Replying to your earlier message: “${flags.replyTo.excerpt}”\n\n${text}`
        : text.trim();
      const asked =
        askedRaw ||
        (quotedPassage
          ? "What should I make of this?"
          : photos.length > 0
            ? "What am I looking at?"
            : "What should I focus on next?");
      const assembled = assembleAskPrompt({
        question: asked,
        quote: quotedPassage,
        marks,
        numbers: numberFootnotes(annotateFootnotesRef.current),
        budget: isLocalPad(problem) ? PAD_ASK_CLIP_CHARS : PROBLEM_ASK_CLIP_CHARS,
      });
      const prompt = assembled.prompt;

      // One Send seeds one thread on the marks the model actually received.
      const attachedFootnoteIds =
        assembled.includedMarkIds.length > 0 || assembled.omittedMarkIds.length > 0
          ? assembled.includedMarkIds
          : marks.map((mark) => mark.id);
      if (marks.length > 0) {
        footnoteCoachUpgradeRef.current = attachedFootnoteIds[0] ?? null;
        setAttachedFootnoteIds([]);
        flagBits.push(
          assembled.omittedMarkIds.length > 0
            ? `${assembled.includedMarkIds.length} of ${marks.length} marks`
            : `${marks.length} mark${marks.length === 1 ? "" : "s"}`,
        );
      }

      return {
        text,
        flags,
        flagBits,
        bubble,
        attachments,
        threadAnchor,
        photos,
        quotedPassage,
        prompt,
        anchorId,
        attachedFootnoteIds,
        omittedMarkCount: assembled.omittedMarkIds.length,
        includedMarkCount: assembled.includedMarkIds.length,
        questionTruncated: assembled.questionTruncated,
      };
    },
    [readingSize, themeId, problem],
  );

  const applyCoachFootnote = useCallback(
    (
      anchorId: string | null,
      userMessageId: string,
      asked: string,
      attachedIds: readonly string[] = [],
    ) => {
      const quoted = pendingQuoteRef.current;
      pendingQuoteRef.current = null;
      const upgradeId = footnoteCoachUpgradeRef.current;
      footnoteCoachUpgradeRef.current = null;
      const rootId = anchorId ?? userMessageId;
      const now = Date.now();
      const thread = { rootId, title: threadTitleFrom(asked), createdAt: now };
      /*
       * Every attached mark lists the thread, not just the one that claimed the
       * upgrade — the reader pointed at all of them, and the hub is where they
       * go looking for the answer.
       */
      if (attachedIds.length > 0) {
        const wanted = new Set(attachedIds);
        setAnnotateFootnotes((current) =>
          current.map((entry) => {
            if (!wanted.has(entry.id)) return entry;
            const threads = entry.threads ?? [];
            return {
              ...entry,
              kind: "coach" as const,
              threadRootId: entry.threadRootId ?? rootId,
              threads: threads.some((existing) => existing.rootId === rootId)
                ? threads
                : [...threads, thread],
            };
          }),
        );
        setCoachFocusThread({ token: now, rootId });
        if (!quoted && (!upgradeId || wanted.has(upgradeId))) return;
      }
      if (quoted) {
        setAnnotateFootnotes((current) =>
          addFootnote(current, {
            id: freshFootnoteId(current),
            kind: "coach",
            anchor: quoted.anchor,
            excerpt: quoted.excerpt,
            createdAt: now,
            threadRootId: rootId,
            threads: [thread],
            ...footnoteThemeSeed(current.length),
            ...(quoted.hitRects.length > 0 ? { bands: quoted.hitRects } : {}),
            ...(quoted.text.trim() ? { blockText: quoted.text } : {}),
          }),
        );
        return;
      }
      if (!upgradeId) return;
      setAnnotateFootnotes((current) =>
        current.map((entry) => {
          if (entry.id !== upgradeId) return entry;
          const threads = entry.threads ?? [];
          return {
            ...entry,
            kind: "coach" as const,
            threadRootId: entry.threadRootId ?? rootId,
            threads: threads.some((existing) => existing.rootId === rootId)
              ? threads
              : [...threads, thread],
          };
        }),
      );
      setCoachFocusThread({ token: now, rootId });
    },
    [],
  );

  const executeCoachSend = useCallback(
    async (item: CoachSendQueueItem) => {
      coachSendDepthRef.current += 1;
      try {
        const { text, flags, prompt, attachments, threadAnchor, photos, quotedPassage, userMessageId } =
          item;

        if (item.questionTruncated) {
          setNotice("The question was truncated for the model.");
        } else if ((item.omittedMarkCount ?? 0) > 0) {
          const sent = item.includedMarkCount ?? 0;
          const total = sent + (item.omittedMarkCount ?? 0);
          setNotice(`Only ${sent} of ${total} attached marks fit this Ask.`);
        }

        setAgentMessages((current) =>
          current.map((message) =>
            message.id === userMessageId ? { ...message, queued: undefined } : message,
          ),
        );

        const flagBits = flagBitsFor(flags);
        const pendingAck: CoachPendingAck = {
          flags: flagBits,
          hasQuestion: Boolean(text.trim() || quotedPassage),
          boardAttached:
            flags.reviewBoard ||
            flags.handwriting ||
            flags.annotations ||
            flags.lazy ||
            flags.draw ||
            Boolean(attachments?.length),
          photoCount: photos.length,
        };

        if (flags.reviewBoard) {
          await submitForReview(
            prompt,
            true,
            attachments,
            flags.lazy,
            threadAnchor,
            pendingAck,
          );
        } else if (flags.ask || text || photos.length > 0 || quotedPassage) {
          /*
           * The board pictures go with the question, not just onto the bubble.
           *
           * `attachments` is what Annotate exported — the marked pages, or the
           * current view. Review has always forwarded them; Ask rendered them
           * under the turn and then sent a payload without them, so "Ask +
           * Annotate > Whole board" asked the coach about pages it could not
           * see. Same asymmetry the Review/photo interlock fixed, one endpoint
           * over.
           *
           * Fallback wording is already reserved inside `prompt` by
           * assembleAskPrompt — do not append it after the packed marks, or
           * the daemon's front-clip can delete the ask.
           */
          const boardShots: CoachAttachment[] = (attachments ?? []).map((shot) => ({
            label: shot.label,
            png: shot.png,
          }));
          await askAgent(
            prompt,
            threadAnchor,
            [...photos, ...boardShots],
            pendingAck,
            {
              preset: flags.askPreset,
              highlight: quotedPassage,
              reasoning: flags.reasoning,
            },
          );
        }
        if (flags.draw) {
          await askForDiagram(text, threadAnchor);
        }
        if (flags.lazy && problem) {
          setBusy("lazy fill…");
          try {
            await syncSolution();
            const board = boardRef.current;
            const snapshot = board
              ? await buildSnapshot(board, recognizerRef.current, {
                  pseudocode: undefined,
                  includePng: modeHasVision("review"),
                })
              : null;
            const lazyBoard = snapshot?.board ?? {
              recognized_text: text || "Lazy fill from board",
              pseudocode: pseudocodeRef.current.trim() || undefined,
            };
            const fill = await runCoachJob<LazyFillResponse>(
              "lazy",
              { task_id: problem.task_id, dataset: problem.dataset, board: lazyBoard },
              null,
              () => client.lazyFill(problem.task_id, lazyBoard, problem.dataset),
            );
            await applyFilledCode(fill.filled_code, fill.note, threadAnchor);
          } catch (cause) {
            setError(messageOf(cause));
          } finally {
            setBusy(null);
          }
        }
      } finally {
        coachSendDepthRef.current -= 1;
        if (coachSendDepthRef.current === 0 && busyRef.current === null) {
          drainCoachSendQueueRef.current();
        }
      }
    },
    [
      submitForReview,
      askAgent,
      askForDiagram,
      problem,
      client,
      syncSolution,
      modeHasVision,
      applyFilledCode,
      runCoachJob,
      flagBitsFor,
    ],
  );

  /**
   * The turn the coach's answer hangs off.
   *
   * A send that carries marks *is* the start of their thread, so the answer has
   * to reply to the message that carried them. Left as a plain room message it
   * would still be on screen, but `groupThreads` would not put it under that
   * root — and the mark's hub entry would open a transcript holding the
   * question with no answer in it.
   */
  const sendThreadAnchor = useCallback(
    (
      prepared: {
        threadAnchor: CoachReplyRef | null;
        bubble: string;
        attachedFootnoteIds: readonly string[];
      },
      userMessageId: string,
    ): CoachReplyRef | null =>
      prepared.threadAnchor ??
      (prepared.attachedFootnoteIds.length > 0
        ? {
            id: userMessageId,
            role: "user" as const,
            excerpt: replyExcerpt(prepared.bubble) || "Message",
          }
        : null),
    [],
  );

  const enqueueCoachSend = useCallback(
    async (text: string, flags: AgentSendFlags) => {
      const prepared = await prepareCoachSend(text, flags);
      const userMessageId = pushCoachMessage("user", prepared.bubble, {
        ...(prepared.attachments ? { attachments: prepared.attachments } : {}),
        ...(prepared.flagBits.length > 0 ? { flags: prepared.flagBits } : {}),
        ...(flags.replyTo ?? prepared.threadAnchor
          ? { replyTo: flags.replyTo ?? prepared.threadAnchor ?? undefined }
          : {}),
        queued: true,
      });
      applyCoachFootnote(
        prepared.anchorId,
        userMessageId,
        prepared.text,
        prepared.attachedFootnoteIds,
      );
      coachSendQueueRef.current.push({
        text: prepared.text,
        flags: prepared.flags,
        userMessageId,
        prompt: prepared.prompt,
        attachments: prepared.attachments,
        threadAnchor: sendThreadAnchor(prepared, userMessageId),
        photos: prepared.photos,
        quotedPassage: prepared.quotedPassage,
        anchorId: prepared.anchorId,
        omittedMarkCount: prepared.omittedMarkCount,
        includedMarkCount: prepared.includedMarkCount,
        questionTruncated: prepared.questionTruncated,
      });
    },
    [prepareCoachSend, pushCoachMessage, applyCoachFootnote, sendThreadAnchor],
  );

  const drainCoachSendQueue = useCallback(() => {
    if (busyRef.current !== null) return;
    const next = coachSendQueueRef.current.shift();
    if (!next) return;
    void executeCoachSendRef.current(next);
  }, []);

  executeCoachSendRef.current = executeCoachSend;
  drainCoachSendQueueRef.current = drainCoachSendQueue;

  const sendCoachChat = useCallback(
    (text: string, requestedFlags: AgentSendFlags, mode: "queue" | "merge" = "queue") => {
      const flags = normalizeCoachFlags(requestedFlags);

      if (mode === "merge" && busyRef.current !== null) {
        coachRef.current?.cancelAll();
        coachRunGenRef.current += 1;
        const activeTurn = activeCoachTurnIdRef.current;
        if (activeTurn) {
          finishCoachTurn(activeTurn, null);
          activeCoachTurnIdRef.current = null;
        }
        setCoachPhase("Updating with your new messages…");
        setBusy(null);
        // Keep queued user bubbles on screen; drop the waiting jobs. One new
        // ask sees them all via withConversationContext.
        const queuedIds = new Set(
          coachSendQueueRef.current.map((item) => item.userMessageId),
        );
        coachSendQueueRef.current = [];
        setAgentMessages((current) =>
          current.map((message) =>
            message.queued || queuedIds.has(message.id)
              ? { ...message, queued: undefined }
              : message,
          ),
        );
        void (async () => {
          const prepared = await prepareCoachSend(text, flags);
          const userMessageId = pushCoachMessage("user", prepared.bubble, {
            ...(prepared.attachments ? { attachments: prepared.attachments } : {}),
            ...(prepared.flagBits.length > 0 ? { flags: prepared.flagBits } : {}),
            ...(flags.replyTo ?? prepared.threadAnchor
              ? { replyTo: flags.replyTo ?? prepared.threadAnchor ?? undefined }
              : {}),
          });
          applyCoachFootnote(
            prepared.anchorId,
            userMessageId,
            prepared.text,
            prepared.attachedFootnoteIds,
          );
          await executeCoachSend({
            text: prepared.text,
            flags: prepared.flags,
            userMessageId,
            prompt: prepared.prompt,
            attachments: prepared.attachments,
            threadAnchor: sendThreadAnchor(prepared, userMessageId),
            photos: prepared.photos,
            quotedPassage: prepared.quotedPassage,
            anchorId: prepared.anchorId,
            omittedMarkCount: prepared.omittedMarkCount,
            includedMarkCount: prepared.includedMarkCount,
            questionTruncated: prepared.questionTruncated,
          });
        })();
        return;
      }

      if (mode === "queue" && busyRef.current !== null) {
        void enqueueCoachSend(text, flags);
        suppressCoachPanelOpenRef.current = false;
        return;
      }

      void (async () => {
        const prepared = await prepareCoachSend(text, flags);
        const userMessageId = pushCoachMessage("user", prepared.bubble, {
          ...(prepared.attachments ? { attachments: prepared.attachments } : {}),
          ...(prepared.flagBits.length > 0 ? { flags: prepared.flagBits } : {}),
          ...(flags.replyTo ?? prepared.threadAnchor
            ? { replyTo: flags.replyTo ?? prepared.threadAnchor ?? undefined }
            : {}),
        });
        applyCoachFootnote(
          prepared.anchorId,
          userMessageId,
          prepared.text,
          prepared.attachedFootnoteIds,
        );
        await executeCoachSend({
          text: prepared.text,
          flags: prepared.flags,
          userMessageId,
          prompt: prepared.prompt,
          attachments: prepared.attachments,
          threadAnchor: sendThreadAnchor(prepared, userMessageId),
          photos: prepared.photos,
          quotedPassage: prepared.quotedPassage,
          anchorId: prepared.anchorId,
          omittedMarkCount: prepared.omittedMarkCount,
          includedMarkCount: prepared.includedMarkCount,
          questionTruncated: prepared.questionTruncated,
        });
      })();
    },
    [
      normalizeCoachFlags,
      prepareCoachSend,
      pushCoachMessage,
      applyCoachFootnote,
      executeCoachSend,
      enqueueCoachSend,
      finishCoachTurn,
      sendThreadAnchor,
    ],
  );

  const sendCoachFromFootnote = useCallback(
    (text: string, threadRootId: string | null) => {
      const footnote = annotateFootnotes.find((entry) => entry.id === openFootnoteId);
      if (!footnote) return;
      // Every send from the card claims the mark, not just the first: a second
      // thread has to be recorded on the footnote the same way the first was,
      // or the card lists one conversation however many were started.
      footnoteCoachUpgradeRef.current = footnote.id;
      const replyTo = threadRootId
        ? threadAnchorRef(agentMessagesRef.current, threadRootId) ?? undefined
        : undefined;
      // Stay in the overview card — do not dock the side coach over the page.
      suppressCoachPanelOpenRef.current = true;
      sendCoachChat(text, {
        ask: true,
        draw: false,
        reviewBoard: false,
        lazy: false,
        handwriting: false,
        annotations: false,
        reasoning: loadAgentReasoningLevel(),
        ...(footnote.excerpt ? { pageQuote: footnote.excerpt } : {}),
        ...(replyTo ? { replyTo } : {}),
        threadRootId,
      });
      // Cleared when the send finishes — not in a microtask, or askAgent opens
      // the side panel before suppress is still set.
      if (threadRootId) {
        setCoachFocusThread({ token: Date.now(), rootId: threadRootId });
      }
    },
    [annotateFootnotes, openFootnoteId, sendCoachChat],
  );

  /**
   * Run the workspace's tests and put the results everywhere they belong:
   * the modal over the board, the coach thread as an `app` turn, and the next
   * coach request as its own channel. One run, three destinations — closing
   * the modal therefore loses nothing.
   */
  const runTestsWith = useCallback(
    async (kind: "run" | "submit") => {
      if (!problem) return;
      setBusy(kind === "submit" ? "submitting…" : "running the tests…");
      setError(null);
      try {
        await syncSolution();
        const result = await client.runTests(problem.task_id, problem.dataset);
        setLastRunKind(kind);
        setTests(result);
        const report = formatTestReport(result, kind);
        lastTestReportRef.current = report;
        pushCoachMessage("app", report);
        dirtyRef.current = true;
        /*
         * Hand a red run straight to the coach, when asked to.
         *
         * The report is already in the thread, so the model would see it on the
         * next question anyway — what this buys is not having to ask. The code
         * rides along because a traceback without the source is a line number
         * with nothing at the end of it.
         */
        if (!result.all_passed) {
          const mode = testForwardRef.current;
          const rootId = threadRootIdRef.current;
          const threadAnchor = rootId
            ? threadAnchorRef(agentMessagesRef.current, rootId)
            : null;
          const code = pseudocodeRef.current;
          if (mode === "whole-run") {
            void askAgentRef.current?.(describeRunFailure(report, code), threadAnchor);
          } else if (mode === "per-case") {
            for (const failing of result.results.filter((entry) => !entry.pass)) {
              const caseReport = [
                `${failing.suite ? "suite" : `case ${failing.case}`}: ${failing.input}`,
                `  expected: ${failing.expected}`,
                failing.actual !== null ? `  got:      ${failing.actual}` : "",
                failing.error ? `  error:    ${failing.error}` : "",
              ]
                .filter(Boolean)
                .join("\n");
              void askAgentRef.current?.(describeRunFailure(caseReport, code), threadAnchor);
            }
          }
        }
        if (result.all_passed) {
          setAttemptState((current) => ({
            solved: true,
            saved: current?.saved ?? false,
            archives: current?.archives ?? [],
            updated_at: Math.floor(Date.now() / 1000),
          }));
        }
        await refreshSession();
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(null);
      }
    },
    [client, problem, syncSolution, refreshSession, pushCoachMessage],
  );

  const runTests = useCallback(() => runTestsWith("run"), [runTestsWith]);
  const submitSolution = useCallback(() => runTestsWith("submit"), [runTestsWith]);

  const pickRandomProblem = useCallback(async () => {
    try {
      const next = await client.randomProblem(bankFilters);
      if (next) void pickProblem(next.task_id, { ...bankFilters, dataset: next.dataset });
      else setError("no problems match the current filters");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client, bankFilters, pickProblem]);


  /** Confirmed by a short hold in `ConfirmDialog`, never by `window.confirm`. */
  const resetSession = useCallback(async () => {
    setResetPending(true);
    setResetError(null);
    try {
      setSession(await client.resetSession());
      setNavigateBySession(false);
      setResetOpen(false);
    } catch (cause) {
      setResetError(messageOf(cause));
    } finally {
      setResetPending(false);
    }
  }, [client]);


  const openInIde = useCallback(async () => {
    if (!problem) return;
    try {
      await client.openWorkspace(problem.task_id, "ide", problem.dataset);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client, problem]);

  // Deep link: ?task=<id>[&dataset=<slug>] loads that problem once. The TUI's
  // "Open in Canvas" builds this URL, and it names the dataset because the
  // same slug exists in several of them.
  useEffect(() => {
    if (deepLinkHandled.current || problem) return;
    const params = new URLSearchParams(window.location.search);
    const task = params.get("task");
    if (!task) return;
    deepLinkHandled.current = true;
    void pickProblem(task, { dataset: params.get("dataset") ?? DEFAULT_DATASET });
  }, [pickProblem, problem]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  /**
   * Persist the coach thread beside the workspace, debounced.
   *
   * Written on every change rather than only on leave: a crash or a closed lid
   * should not cost the conversation, and `attempt::finish` is what decides
   * whether the stored thread survives into the next attempt.
   *
   * Documents write the thread onto the library entry (with the board and
   * marks). They must not hit `putAgentSession` — md-ink is not a corpus slug.
   */
  useEffect(() => {
    if (!problem || agentMessages.length === 0) return;
    const timer = window.setTimeout(() => {
      if (agentSaveSuspendedRef.current) return;
      const agent = persistableAgentMessages(agentMessages);
      if (isAnnotate(problem)) {
        // Board autosave only writes when the scene + marks fingerprint moves,
        // so a chat-only exchange would otherwise be lost — same reason the
        // whiteboard writes the notebook here. A PDF mark still only stores a
        // rootId pointer; the transcript lives on the library entry.
        const board = boardRef.current;
        const source = annotateSourceRef.current;
        if (!board || !source) return;
        void (async () => {
          await flushDirtyInk(
            board,
            annotateDocIdRef.current ? annotateDocKey(annotateDocIdRef.current) : null,
          );
          const liveBoard = board.saveBoard({ assembleInk: false });
          try {
            const saved = await saveAnnotateDoc({
              id: annotateDocIdRef.current ?? undefined,
              name: source.name,
              hash: source.hash,
              source: source.text,
              docType: source.docType,
              board: liveBoard,
              footnotes: annotateFootnotesRef.current,
              agent,
            });
            if (!annotateDocIdRef.current) setAnnotateDocId(saved.id);
            void pushAnnotatePad(client, saved);
          } catch (cause: unknown) {
            if (cause instanceof AnnotateLibraryFullError) {
              setError(cause.message);
            } else {
              noteStorageFull(cause);
            }
          }
        })();
        return;
      }
      if (isWhiteboard(problem)) {
        // Board autosave only writes when the scene + ink fingerprint moves, so
        // a chat-only exchange would otherwise be lost. Write the notebook with
        // the current board so the thread survives a crash or a closed lid.
        const board = boardRef.current;
        const blob = board?.saveBoard();
        if (!blob) return;
        void saveWhiteboardNotebook({
          id: whiteboardNotebookId ?? undefined,
          board: blob,
          agent,
          pageCount: Math.max(whiteboardPageCount, countWhiteboardPages(blob.elements)),
        })
          .then((saved) => {
            if (!whiteboardNotebookId) setWhiteboardNotebookId(saved.id);
            void pushWhiteboardPad(client, saved);
          })
          .catch((cause: unknown) => {
            if (cause instanceof WhiteboardLibraryFullError) {
              whiteboardLibResumeRef.current = null;
              setWhiteboardLibOpen(true);
            } else {
              noteStorageFull(cause);
            }
          });
        return;
      }
      void client
        .putAgentSession(problem.task_id, agent, problem.dataset)
        .catch(() => {
          /* best-effort — the thread is still on screen */
        });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [client, problem, agentMessages, whiteboardNotebookId, whiteboardPageCount, noteStorageFull]);

  const confirmReveal = useCallback(async (mode: "bridge" | "lazy" = "bridge") => {
    const board = boardRef.current;
    if (!problem) return;
    const targetId = revealForMessageIdRef.current;
    setRevealOpen(false);
    setRevealPending(false);
    setRevealError(null);
    dirtyRef.current = true;
    setAgentMessages((current) => {
      const attachTo =
        (targetId && current.find((message) => message.id === targetId)) ||
        [...current].reverse().find((message) => message.role === "assistant" && message.review);
      if (!attachTo) return current;
      return current.map((message) =>
        message.id === attachTo.id
          ? { ...message, bridgePending: true, bridgeError: null }
          : message,
      );
    });
    try {
      const snapshot = board
        ? await buildSnapshot(board, recognizerRef.current, { pseudocode: pseudocodeRef.current })
        : null;
      const result = await client.reveal(
        problem.task_id,
        snapshot?.board ?? { recognized_text: "" },
        true,
        problem.dataset,
        mode,
      );
      if (mode === "lazy" && result.filled_code) {
        await applyFilledCode(
          result.filled_code,
          result.lazy_note ?? "Lazy fill applied from the hint.",
        );
      }
      setAgentMessages((current) => {
        const attachTo =
          (targetId && current.find((message) => message.id === targetId)) ||
          [...current].reverse().find(
            (message) => message.role === "assistant" && message.review && message.bridgePending,
          );
        if (!attachTo) return current;
        return current.map((message) =>
          message.id === attachTo.id
            ? { ...message, bridge: result, bridgePending: false, bridgeError: null }
            : message,
        );
      });
      revealForMessageIdRef.current = null;
    } catch (cause) {
      const message = messageOf(cause);
      setAgentMessages((current) => {
        const attachTo =
          (targetId && current.find((entry) => entry.id === targetId)) ||
          [...current].reverse().find(
            (entry) => entry.role === "assistant" && entry.review && entry.bridgePending,
          );
        if (!attachTo) return current;
        return current.map((entry) =>
          entry.id === attachTo.id
            ? { ...entry, bridgePending: false, bridgeError: message }
            : entry,
        );
      });
    }
  }, [client, problem, applyFilledCode]);

  const showDrawingFrame = useCallback(
    (programId: string, frameIndex: number) => {
      const board = boardRef.current;
      const api = sceneApi();
      if (!board || !api) return;
      dirtyRef.current = true;
      if (mobile) setActiveRegion("agent");
      setAgentMessages((current) => {
        const next = current.map((message) => {
          if (message.drawing?.program.id !== programId) return message;
          return {
            ...message,
            drawing: { ...message.drawing, frameIndex },
          };
        });
        const drawing = next.find((message) => message.drawing?.program.id === programId)?.drawing;
        if (drawing && drawing.expanded && !drawing.redacted) {
          applyViz(
            api,
            (skeletons) => board.convert(skeletons, { regenerateIds: false }),
            drawing.program,
            frameIndex,
          );
        }
        return next;
      });
    },
    [sceneApi, mobile],
  );

  const toggleDrawing = useCallback(
    (messageId: string, expanded: boolean) => {
      dirtyRef.current = true;
      if (expanded && mobile) setActiveRegion("agent");
      setAgentMessages((current) => {
        const next = setDrawingExpanded(current, messageId, expanded);
        queueMicrotask(() => syncDrawingsToBoard(next));
        return next;
      });
    },
    [syncDrawingsToBoard, mobile],
  );



  /**
   * Ask about saving before leaving, then do `next`.
   *
   * Only asked when there is something to keep: an untouched workspace has no
   * decision worth interrupting for. `AttemptDialog` explains which of the two
   * questions is being asked.
   */
  /**
   * Nothing has happened to this notebook since it opened.
   *
   * The fingerprint covers the scene and the ink op count together, so it
   * catches a stray stroke as readily as a page added and left blank. Without
   * a pristine hash — a notebook opened before this ran, say — the honest
   * answer is "assume they did something" and show the menu.
   */
  const whiteboardUntouched = useCallback(() => {
    const board = boardRef.current;
    if (!board) return false;
    const pristine = whiteboardPristineHashRef.current;
    // Open race: pristine not snapshotted yet. Only claim untouched when the
    // board still looks blank (no ink) — never show Discard for a mid-open board.
    if (pristine === null) return board.getInkOpCount() === 0;
    return padContentFingerprint(board.getElements(), board.getInkOpCount()) === pristine;
  }, []);

  /**
   * Undo everything this session committed to the library.
   *
   * Restores the entry the session opened on, or deletes the notebook outright
   * when it opened blank — the autosave will have created one by now, and that
   * entry exists only because the writer was mid-session, not because they
   * asked for it.
   */
  /**
   * Treat what is in the library now as the thing to fall back to.
   *
   * Called after an explicit Save, so that a Discard later in the same session
   * rolls back to the save rather than past it. Without this, saving from the
   * scratchpad menu and then discarding on the way out would have thrown away
   * the save the writer had just asked for — the worst possible reading of a
   * button labelled Discard.
   */
  const rebaselineWhiteboardSession = useCallback(async (id: string) => {
    whiteboardBaselineRef.current = { id, entry: await getWhiteboardNotebook(id) };
    /*
     * Move the "have they written anything?" mark up to the save as well.
     *
     * That mark is what decides whether the leave dialog says Discard or Exit,
     * and Discard is measured against the baseline just set above — so leaving
     * it at the session's opening state would have the dialog offering to throw
     * away work that has already been kept, which is precisely the thing the
     * baseline exists to stop it doing.
     */
    const board = boardRef.current;
    whiteboardPristineHashRef.current = board
      ? padContentFingerprint(board.getElements(), board.getInkOpCount())
      : null;
  }, []);

  /**
   * Commit the notebook to the library now.
   *
   * The same thing the Save entry in the scratchpad sheet does, lifted out so
   * the header's paper icon can do it on a tap. Hold opens the save / load
   * sheet instead: an explicit save was three taps through a menu, which is
   * enough friction that people stop bothering and lean on the autosave — and
   * the autosave deliberately does not decide what they meant to keep.
   *
   * `onFull` is how the caller says what to reopen once a full library has been
   * pruned, since that differs between the sheet and the header.
   */
  const saveWhiteboardNow = useCallback(
    async (onFull?: () => void, opts?: { quiet?: boolean }) => {
      const board = boardRef.current;
      if (!board || !problem || !isWhiteboard(problem)) return;
      try {
        await flushDirtyInk(board, whiteboardNotebookId ? whiteboardDocKey(whiteboardNotebookId) : null);
        const liveBoard = board.saveBoard({ assembleInk: false });
        const saved = await saveWhiteboardNotebook({
          id: whiteboardNotebookId ?? undefined,
          board: liveBoard,
          agent: persistableAgentMessages(agentMessages),
          pageCount: Math.max(whiteboardPageCount, countWhiteboardPages(liveBoard.elements)),
        });
        setWhiteboardNotebookId(saved.id);
        await flushDirtyInk(board, whiteboardDocKey(saved.id));
        await rebaselineWhiteboardSession(saved.id);
        if (!opts?.quiet) setNotice(`Saved “${saved.title}”.`);
        const snapBoard = await boardWithAssembledInk(board, liveBoard);
        void pushWhiteboardPad(client, saved).then((ok) => {
          if (!ok) return;
          void recordRollingSnapshots({
            kind: "whiteboard",
            key: saved.id,
            name: saved.title,
            board: snapBoard,
            agent: saved.agent,
            pageCount: saved.pageCount,
          }).then((written) => void pushRolledSnapshots(client, written));
        });
      } catch (cause) {
        if (cause instanceof WhiteboardLibraryFullError) {
          whiteboardLibResumeRef.current = onFull ?? null;
          setWhiteboardLibOpen(true);
          return;
        }
        setError(messageOf(cause));
      }
    },
    [agentMessages, problem, rebaselineWhiteboardSession, whiteboardNotebookId, whiteboardPageCount, client],
  );

  const discardWhiteboardSession = useCallback(() => {
    const baseline = whiteboardBaselineRef.current;
    // Fire-and-forget, as with the document pad: the session is torn down
    // below regardless, and Discard should not wait on a store write.
    if (baseline.entry && baseline.id) {
      void restoreWhiteboardNotebook(baseline.entry).catch(() => {});
    } else {
      if (whiteboardNotebookId) {
        void deleteWhiteboardNotebook(whiteboardNotebookId).catch(() => {});
      }
      // Nothing to come back to, so the chip goes with it. A discard onto a
      // baseline keeps its tab — that notebook is still in the library.
      closeTab(tab.id);
    }
    whiteboardBaselineRef.current = { id: null, entry: null };
    whiteboardPristineHashRef.current = null;
    setWhiteboardNotebookId(null);
  }, [closeTab, tab.id, whiteboardNotebookId]);

  /** Nothing drawn on this document since it opened. */
  /**
   * Nothing about this session is worth keeping.
   *
   * An untouched *board* is not an untouched *document*: a reading session can
   * quote a passage to the coach or drop a search footnote without ever putting
   * the pen down, and those are exactly as worth keeping as ink. Counting only
   * the board here is what made leaving throw a footnote-only session away
   * without so much as offering to save it — the leave dialog never appeared,
   * because from the board's point of view nothing had happened.
   */
  const annotateUntouched = useCallback(() => {
    const board = boardRef.current;
    const pristine = annotatePristineHashRef.current;
    if (!board || pristine === null) return false;
    /*
     * An edited buffer is a change even when nothing was drawn.
     *
     * The board fingerprint cannot see Monaco, so a note whose text was
     * rewritten but never inked would read as "only read" and be discarded on
     * the way out without so much as a prompt.
     */
    if (annotateOwnedRef.current && editBufferRef.current !== (annotateSourceRef.current?.text ?? "")) {
      return false;
    }
    if (footnoteRevision(annotateFootnotesRef.current) !== annotatePristineMarksRef.current) {
      return false;
    }
    if (
      JSON.stringify(persistableAgentMessages(agentMessagesRef.current)) !==
      annotatePristineAgentRef.current
    ) {
      return false;
    }
    return padContentFingerprint(board.getElements(), board.getInkOpCount()) === pristine;
  }, []);

  /**
   * Throw away this session's annotations — and only those.
   *
   * The markdown is never touched by any of this: the file on disk was only
   * ever read, and the library's copy of the text goes away with the entry it
   * belongs to. Discarding leaves the writer's document exactly as it was.
   */
  const discardAnnotateSession = useCallback(() => {
    const baseline = annotateBaselineRef.current;
    // Fire-and-forget: the in-memory session is torn down below either way, and
    // making Discard wait on a store write would put a spinner on the one
    // action whose whole point is that it costs nothing.
    if (baseline.entry && baseline.id) {
      void restoreAnnotateDoc(baseline.entry).catch(() => {});
    } else {
      if (annotateDocId) void deleteAnnotateDoc(annotateDocId).catch(() => {});
      // See the notebook discard: a tab whose entry has just been deleted has
      // nothing left to reopen.
      closeTab(tab.id);
    }
    annotateBaselineRef.current = { id: null, entry: null };
    annotatePristineHashRef.current = null;
    annotatePristineMarksRef.current = "";
    annotatePristineAgentRef.current = "";
    setAnnotateDocId(null);
    setAnnotateOwned(false);
    setEditMarkdown(false);
    setEditBuffer("");
    setAnnotateFootnotes([]);
    annotateFootnotesRef.current = [];
    pendingQuoteRef.current = null;
    footnoteCoachUpgradeRef.current = null;
    setOpenFootnoteId(null);
    setFootnoteAnchorRect(null);
  }, [annotateDocId, closeTab, tab.id]);

  /** Commit the annotations to the library. Returns the entry, or null on failure. */
  const saveAnnotateSession = useCallback(async (): Promise<AnnotateDoc | null> => {
    const board = boardRef.current;
    const source = annotateSource;
    if (!board || !source) return null;
    // Commit the buffer first: the write below sends `source.text`, which is
    // still the pre-edit copy until `saveEditBuffer` has moved it.
    if (annotateOwnedRef.current && editBufferRef.current !== source.text) {
      await saveEditBuffer();
    }
    await flushDirtyInk(board, annotateDocId ? annotateDocKey(annotateDocId) : null);
    const blob = board.saveBoard({ assembleInk: false });
    if (!blob) return null;
    try {
      const saved = await saveAnnotateDoc({
        id: annotateDocId ?? undefined,
        name: source.name,
        hash: source.hash,
        source: source.text,
        docType: source.docType,
        board: blob,
        footnotes: annotateFootnotes,
        agent: persistableAgentMessages(agentMessages),
      });
      setAnnotateDocId(saved.id);
      annotateBaselineRef.current = { id: saved.id, entry: saved };
      annotatePristineHashRef.current = padContentFingerprint(
        board.getElements(),
        board.getInkOpCount(),
      );
      annotatePristineMarksRef.current = footnoteRevision(annotateFootnotes);
      annotatePristineAgentRef.current = JSON.stringify(persistableAgentMessages(agentMessages));
      const snapBoard = await boardWithAssembledInk(board, blob);
      void pushAnnotatePad(client, saved).then((ok) => {
        if (!ok) return;
        void recordRollingSnapshots({
          kind: "annotate",
          key: saved.id,
          name: saved.name,
          board: snapBoard,
          footnotes: saved.footnotes,
          agent: saved.agent,
        }).then((written) => void pushRolledSnapshots(client, written));
      });
      return saved;
    } catch (cause) {
      if (cause instanceof AnnotateLibraryFullError) {
        setError(cause.message);
        return null;
      }
      setError(messageOf(cause));
      return null;
    }
  }, [annotateDocId, annotateFootnotes, annotateSource, agentMessages, client, saveEditBuffer]);


  /*
   * What a quote from the page can become.
   *
   * Copy leaves no mark. Google and Annotate each drop a ribbon and open the
   * overview card — the browser may still open once when a search is created.
   */
  const openFootnoteOverview = useCallback((id: string, anchorRect: DOMRect | null) => {
    setOpenFootnoteId(id);
    setFootnoteAnchorRect(anchorRect);
  }, []);

  useEffect(() => {
    if (!openFootnoteId) setSubMarkMode(null);
    setHoveredSubMarkId(null);
  }, [openFootnoteId]);

  const onDocAnnotate = useCallback(
    (selection: DocSelectionResult, anchorRect: DOMRect | null) => {
      const id = freshFootnoteId(annotateFootnotesRef.current);
      setAnnotateFootnotes((current) =>
        addFootnote(current, {
          id,
          kind: "note",
          anchor: selection.anchor,
          excerpt: selection.excerpt,
          createdAt: Date.now(),
          ...footnoteThemeSeed(current.length),
          ...(selection.hitRects.length > 0 ? { bands: selection.hitRects } : {}),
          ...(selection.text.trim() ? { blockText: selection.text } : {}),
        }),
      );
      openFootnoteOverview(id, anchorRect);
    },
    [openFootnoteOverview],
  );

  const onDocCopy = useCallback(
    async (selection: DocSelectionResult, _anchorRect: DOMRect | null) => {
      const ok = await copyTextToClipboard(selection.text);
      if (!ok) {
        setError("this device would not let the app write to the clipboard");
      }
      return ok;
    },
    [],
  );

  const onDocSearch = useCallback(
    (selection: DocSelectionResult, anchorRect: DOMRect | null) => {
      const query = searchQueryFor(selection.text);
      if (!query) return;
      const url = googleSearchUrl(query);
      // The footnote is written before the browser opens, not after: leaving the
      // app is exactly when a promise callback is least likely to be waited for.
      const id = freshFootnoteId(annotateFootnotesRef.current);
      setAnnotateFootnotes((current) =>
        addFootnote(current, {
          id,
          kind: "search",
          anchor: selection.anchor,
          excerpt: selection.excerpt,
          createdAt: Date.now(),
          query,
          url,
          ...footnoteThemeSeed(current.length),
          ...(selection.hitRects.length > 0 ? { bands: selection.hitRects } : {}),
          ...(selection.text.trim() ? { blockText: selection.text } : {}),
        }),
      );
      openFootnoteOverview(id, anchorRect);
      void openExternalUrl(url).catch(() => {
        setError("could not hand the search to a browser on this device");
      });
    },
    [openFootnoteOverview],
  );

  const onOpenFootnote = useCallback((footnote: DocFootnote, anchorRect: DOMRect | null) => {
    openFootnoteOverview(footnote.id, anchorRect);
  }, [openFootnoteOverview]);

  const onFootnoteChange = useCallback((next: DocFootnote) => {
    setAnnotateFootnotes((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
  }, []);

  const onAddSubMark = useCallback(
    (mark: DocFootnoteSubMark) => {
      if (!openFootnoteId) return;
      const theme = subMarkPaintThemeRef.current;
      let minted = "";
      setAnnotateFootnotes((current) =>
        current.map((entry) => {
          if (entry.id !== openFootnoteId) return entry;
          const existing = entry.subMarks ?? [];
          minted = freshSubMarkId(existing);
          const next = {
            ...mark,
            id: minted,
            ...(theme ? { color: theme.color, palette: theme.palette } : {}),
          };
          return { ...entry, subMarks: [...existing, next] };
        }),
      );
      if (minted) setActiveSubMarkId(minted);
    },
    [openFootnoteId],
  );

  useEffect(() => {
    if (subMarkMode === "underline") return;
    setActiveSubMarkId(null);
    setSubMarkPaintTheme(null);
  }, [subMarkMode]);

  /** The highlighter's plain outcome: a mark, pointing at nothing but itself. */
  const onDocMark = useCallback((selection: DocSelectionResult) => {
    setAnnotateFootnotes((current) =>
      addFootnote(current, {
        id: freshFootnoteId(current),
        kind: "note",
        anchor: selection.anchor,
        excerpt: selection.excerpt,
        createdAt: Date.now(),
        ...footnoteThemeSeed(current.length),
        ...(selection.hitRects.length > 0 ? { bands: selection.hitRects } : {}),
        ...(selection.text.trim() ? { blockText: selection.text } : {}),
      }),
    );
  }, []);

  const onRemoveFootnote = useCallback((footnote: DocFootnote) => {
    setAnnotateFootnotes((current) => removeFootnote(current, footnote.id));
  }, []);

  /*
   * Which header icon is waiting on a tab it just asked for.
   *
   * Spawning a tab hands the load to a *different* workspace, so nothing here
   * changes and the icon gave no sign it had heard the tap — meanwhile every
   * spawn icon greys out, which reads as the app having gone unresponsive
   * rather than as work in progress. `shellLoadActive` is the shell's own
   * "a tab is loading" flag and is documented to survive the Home → new-tab
   * handoff, so it is the one signal that spans the gap.
   */
  const [spawning, setSpawning] = useState<"web" | "doc" | "board" | null>(null);
  useEffect(() => {
    if (!shellLoadActive) setSpawning(null);
  }, [shellLoadActive]);

  const leaveProblem = useCallback(
    (next: () => void) => {
      if (!problem) {
        next();
        return;
      }
      if (isWhiteboard(problem)) {
        // A notebook nobody wrote in is not a decision worth interrupting for.
        // Leave straight away and take the autosave's placeholder with us.
        if (whiteboardUntouched()) {
          boardSaveSuspendedRef.current = true;
          discardWhiteboardSession();
          next();
          return;
        }
        setLeavingError(null);
        setLeavingPhase("open");
        setLeaving({ run: next });
        return;
      }
      if (isAnnotate(problem)) {
        // Same rule, same reason: an unannotated document is a document that
        // was only read, and reading it is not a decision.
        if (annotateUntouched()) {
          boardSaveSuspendedRef.current = true;
          discardAnnotateSession();
          next();
          return;
        }
        setLeavingError(null);
        setLeavingPhase("open");
        setLeaving({ run: next });
        return;
      }
      if (!dirtyRef.current) {
        next();
        return;
      }
      setLeavingError(null);
      setLeavingPhase("open");
      setLeaving({ run: next });
    },
    [discardAnnotateSession, discardWhiteboardSession, annotateUntouched, problem, whiteboardUntouched],
  );

  const resolveLeave = useCallback(
    async (save: boolean) => {
      const pending = leaving;
      if (!problem || !pending || leavingPending) return;
      setLeavingPending(true);
      setLeavingError(null);
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;

      // Fade the dialog out immediately and show the workspace loading spinner
      // underneath so save/API latency never leaves the modal stuck on screen.
      setLeavingPhase("exit");
      setSwitchMotion("busy");
      setBoardPreparing(true);
      const fadeMs = prefersReducedMotion() ? 0 : LEAVE_DIALOG_FADE_MS;
      const fadeDone = waitMs(fadeMs);

      const dismissDialog = async () => {
        await fadeDone;
        setLeaving(null);
        setLeavingPhase("open");
      };

      try {
        if (isAnnotate(problem)) {
          if (save) {
            const saved = await saveAnnotateSession();
            if (saved) setNotice(`Annotations saved for “${saved.name}”.`);
          } else {
            discardAnnotateSession();
          }
          await dismissDialog();
          setLeavingPending(false);
          pending.run();
          return;
        }
        if (isWhiteboard(problem)) {
          if (save) {
            const handle = boardRef.current;
            if (handle) {
              await flushDirtyInk(
                handle,
                whiteboardNotebookId ? whiteboardDocKey(whiteboardNotebookId) : null,
              );
              const blob = handle.saveBoard({ assembleInk: false });
              try {
                const saved = await saveWhiteboardNotebook({
                  id: whiteboardNotebookId ?? undefined,
                  board: blob,
                  agent: persistableAgentMessages(agentMessages),
                  pageCount: Math.max(whiteboardPageCount, countWhiteboardPages(blob.elements)),
                });
                setWhiteboardNotebookId(saved.id);
                await flushDirtyInk(handle, whiteboardDocKey(saved.id));
                await rebaselineWhiteboardSession(saved.id);
                const snapBoard = await boardWithAssembledInk(handle, blob);
                void pushWhiteboardPad(client, saved).then((ok) => {
                  if (!ok) return;
                  void recordRollingSnapshots({
                    kind: "whiteboard",
                    key: saved.id,
                    name: saved.title,
                    board: snapBoard,
                    agent: saved.agent,
                    pageCount: saved.pageCount,
                  }).then((written) => void pushRolledSnapshots(client, written));
                });
              } catch (cause) {
                if (cause instanceof WhiteboardLibraryFullError) {
                  await dismissDialog();
                  setSwitchMotion("idle");
                  setLeavingPending(false);
                  // Re-open leave flow after the library dialog frees a slot.
                  setLeaving({ run: pending.run });
                  whiteboardLibResumeRef.current = () => {
                    void resolveLeave(true);
                  };
                  setWhiteboardLibOpen(true);
                  return;
                }
                throw cause;
              }
            }
            setNotice("Notebook saved.");
          } else {
            // The autosave has been committing to the library all along, so
            // discarding is real work, not a skipped save.
            discardWhiteboardSession();
          }
          await dismissDialog();
          setLeavingPending(false);
          pending.run();
          return;
        }
        // Flush the thread first, so a "save" keeps the last exchange and an
        // archive of a solved attempt is complete. Dialog is already fading —
        // don't wait on the network to start dismissing.
        const saveWork = (async () => {
          if (agentMessages.length > 0) {
            await client
              .putAgentSession(
                problem.task_id,
                persistableAgentMessages(agentMessages),
                problem.dataset,
              )
              .catch(() => {
                /* best-effort */
              });
          }
          await client.finishAttempt(
            problem.task_id,
            { solved: attemptState?.solved ?? tests?.all_passed ?? false, save },
            problem.dataset,
          ).then(async (outcome) => {
            if (outcome.kept_layout) return;
            const id = problemPadId(problem.dataset, problem.task_id);
            await tombstonePad(client, "problem", id);
            await deleteProblemBoard(id).catch(() => {});
          });
        })();

        await dismissDialog();
        await saveWork;
        setLeavingPending(false);
        // Keep switchMotion busy — pending.run() (pickProblem / browse) takes over.
        pending.run();
      } catch (cause) {
        // The workspace is untouched on a failure — bring the dialog back.
        await fadeDone;
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setSwitchMotion("idle");
        setLeavingPhase("open");
        setLeavingPending(false);
        setLeavingError(messageOf(cause));
        // If we already unmounted during dismiss, remount with the error.
        setLeaving((current) => current ?? { run: pending.run });
      }
    },
    [
      client,
      discardAnnotateSession,
      discardWhiteboardSession,
      saveAnnotateSession,
      rebaselineWhiteboardSession,
      problem,
      leaving,
      leavingPending,
      agentMessages,
      attemptState,
      tests,
      whiteboardNotebookId,
      whiteboardPageCount,
    ],
  );



  /**
   * The tab opened; what it pointed at did not.
   *
   * The chip stays, and it stays focused. Closing it out from under the tap
   * would be the app deciding on the reader's behalf at the exact moment they
   * said what they wanted — so the switch they asked for happens, they land on
   * an empty workspace, and the prompt explains it there. A notebook deleted
   * from the library, a PDF whose file has gone, a problem set uninstalled
   * since: same shape, same three answers.
   */
  const onBrowseTableReady = useCallback(() => {}, []);

  const startFreshSession = useCallback(
    async (taskIds: string[], bank: SearchOptions) => {
      try {
        setBankFilters(bank);
        let next = await client.resetSession();
        for (const id of taskIds) {
          next = await client.enqueueSession(id, bank.dataset);
        }
        setSession(next);
        setNavigateBySession(true);
        if (taskIds[0]) void pickProblem(taskIds[0], bank, { keepSessionNav: true });
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, pickProblem],
  );

  const startRandomSession = useCallback(
    async (filters: SearchOptions = bankFilters) => {
      try {
        setBankFilters(filters);
        const next = await client.randomSession({
          dataset: filters.dataset,
          count: 5,
          difficulty: filters.difficulty,
          tag: filters.tag,
          q: filters.q,
        });
        setSession(next);
        setNavigateBySession(true);
        const first = next.queue[0];
        if (first) {
          const [firstDataset, firstTask] = splitProblemKey(first);
          void pickProblem(firstTask, { ...filters, dataset: firstDataset }, { keepSessionNav: true });
        }
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, bankFilters, pickProblem],
  );

  const reportMissingTab = useCallback(
    (missing: TabRecord, detail: string) => {
      // Stop every beat of the load that just failed; nothing downstream is
      // going to, because the thing that would have is the failure.
      setSwitchMotion("idle");
      setBoardPreparing(false);
      setEntering(false);
      setHoldBrowseOverlay(false);
      setBrowseMotion("idle");
      setWorkspaceLoadActive(false);
      setShellLoadActive(false);
      setBusy(null);
      setError(null);
      // The chip and the prompt are the shell's. This workspace stays mounted
      // and empty underneath it, which is what the reader asked to land on.
      onMissingContent(missing.id, missing.title, detail);
    },
    [onMissingContent, setBrowseMotion, setError, setHoldBrowseOverlay, setShellLoadActive],
  );

  /**
   * Re-open the workspace a record points at.
   *
   * Every arm is the same call the icons and the libraries make, because a
   * parked tab and a fresh open are the same act: read the entity back out of
   * the store it was already being written to. Nothing here is a tab-specific
   * restore path.
   */
  const openTabWorkspace = useCallback(
    async (tab: TabRecord) => {
      const userLoad = takeUserLoad(tab.id);
      switch (tab.kind) {
        case "home":
          // Home has no board to read back; the chooser is the whole of it.
          setBusy(null);
          setWorkspaceLoadActive(false);
          setBoardPreparing(false);
          return;
        case "practice": {
          /*
           * A dataset uninstalled since the tab was opened, or a daemon that
           * cannot answer right now — from here they look the same, and both
           * are worth a prompt with Try again rather than an error banner over
           * a board that never opened.
           */
          const opened = await loadProblem(
            tab.taskId,
            { ...bankFilters, dataset: tab.dataset },
            { tabId: tab.id, userLoad },
          );
          if (!opened) {
            reportMissingTab(tab, `“${tab.taskId}” could not be loaded from ${tab.dataset}.`);
          }
          return;
        }
        case "whiteboard": {
          /*
           * A blank notebook has no id and reopens blank, which is correct. An
           * id that the library no longer answers for is a deleted notebook,
           * and silently handing back an empty board would look like the
           * writing had been lost rather than the notebook removed.
           */
          if (tab.notebookId && !(await getWhiteboardNotebook(tab.notebookId))) {
            reportMissingTab(tab, "The notebook is no longer in the library on this device.");
            return;
          }
          // The loader, not the request wrapper: a blank notebook has no id to
          // be recognised by, so asking to "open" one would grow a second chip
          // rather than refill the one being focused.
          await loadWhiteboard({ notebookId: tab.notebookId, tabId: tab.id, userLoad });
          return;
        }
        case "web": {
          const entry = currentEntry(tab);
          if (!entry) {
            reportMissingTab(tab, "The captured page is no longer in memory.");
            return;
          }
          if (!entry.html) {
            const fetchGen = workspaceLoadGenRef.current;
            try {
              const page = await fetchWebPage(entry.url);
              if (workspaceLoadGenRef.current !== fetchGen) return;
              webPush(tab.id, {
                url: page.url,
                title: page.title || hostLabelFromUrl(page.url),
                html: page.html,
              });
              await loadAnnotate({
                name: page.url,
                docType: "web",
                text: page.html,
                tabId: tab.id,
                userLoad,
              });
            } catch {
              if (workspaceLoadGenRef.current !== fetchGen) return;
              reportMissingTab(tab, "The page could not be fetched again.");
            }
            return;
          }
          await showWebEntry(tab, userLoad);
          return;
        }
        case "annotate": {
          const entry = tab.docId
            ? await getAnnotateDoc(tab.docId)
            : tab.hash
              ? await findAnnotateDocByHash(tab.hash)
              : null;
          /*
           * The record's id outranks the entry's, because it may not have one.
           *
           * A set that has been drawn on but not yet saved has an id on the
           * record and nothing in the library behind it. Falling back to
           * `entry?.id` there would hand the reload no id at all, a second one
           * would be minted, and the ink already in the WAL under the first
           * would be stranded under a key nothing looks up again.
           */
          const restoreDocId = tab.docId ?? entry?.id;
          const docType = entry?.docType ?? tab.docType;
          const name = entry?.name ?? tab.title;
          /*
           * Three places the document can come back from, in order of how
           * much they know: the library entry with its annotations; the bytes
           * IndexedDB kept under the hash whether or not anything was written
           * on them; and — for a document that was only read, and so was never
           * written anywhere — the text parked on the record itself.
           */
          if (isBinaryDocType(docType)) {
            const hash = entry?.hash ?? tab.hash;
            const bytes = hash ? await getDocBytes(hash).catch(() => null) : null;
            if (bytes) {
              await loadAnnotate({ name, docType, bytes, docId: restoreDocId, tabId: tab.id, userLoad });
              return;
            }
            reportMissingTab(
              tab,
              "It is still in the library, but its file is not on this device — open the file again to restore the annotations.",
            );
            return;
          }
          const text = entry?.source ?? tab.source;
          if (text !== null && text !== undefined) {
            await loadAnnotate({ name, docType, text, docId: restoreDocId, tabId: tab.id, userLoad });
            return;
          }
          reportMissingTab(tab, "The document is not in the library and its file is not on this device.");
          return;
        }
      }
    },
    [
      bankFilters,
      loadAnnotate,
      loadProblem,
      loadWhiteboard,
      reportMissingTab,
      showWebEntry,
      takeUserLoad,
      webPush,
    ],
  );

  /**
   * Focus a tab: tear the live workspace down, then mount the one asked for.
   *
   * One board is live, so switching really is leaving — and leaving already
   * has a contract (`leaveProblem`: save, discard, or think about it), which
   * is reused here rather than adding a second, quieter way to lose strokes.
   * The `suspend()` that makes a switch silent is the next step in the plan,
   * and it belongs with the 2–3 live boards it exists to serve.
   */
  /**
   * Let go of the live workspace without asking, and without discarding it.
   *
   * A *switch* is not a *leave*. Leaving says the writer is done with the
   * thing, which is why it gets a dialog; moving to another tab says nothing
   * of the kind. A prompt on every switch is a nag, and worse than a nag — it
   * puts a Discard button under work that was only being parked, which is how
   * an untouched notebook and an unannotated document used to lose their
   * chips on the way out.
   *
   * So parking commits whatever the autosave tick has not caught up with and
   * stops there. The blank cases write nothing at all: a notebook nobody drew
   * on still leaves no empty entry in the library, and a document that was
   * only read is held on its record instead (see `AnnotateTab.source`).
   */
  const parkWorkspace = useCallback(
    (next: () => void) => {
      const board = boardRef.current;
      if (!problem || !board) {
        next();
        return;
      }
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;
      setSwitchMotion("busy");
      setBoardPreparing(true);
      void (async () => {
        try {
          if (isAnnotate(problem)) {
            if (!annotateUntouched()) await saveAnnotateSession();
          } else if (isWhiteboard(problem)) {
            if (!whiteboardUntouched()) await saveWhiteboardNow(undefined, { quiet: true });
          } else {
            // A problem workspace is an open attempt and parking does not end
            // it — no `finishAttempt` here. The solution and the thread are
            // what would otherwise be a few seconds behind.
            await syncSolution().catch(() => {});
            if (agentMessagesRef.current.length > 0) {
              await client
                .putAgentSession(
                  problem.task_id,
                  persistableAgentMessages(agentMessagesRef.current),
                  problem.dataset,
                )
                .catch(() => {});
            }
          }
        } catch {
          // The record survives regardless, and the switch must not stall on
          // a store that is refusing writes. The autosave will say so.
        }
        next();
      })();
    },
    [
      annotateUntouched,
      client,
      problem,
      saveAnnotateSession,
      saveWhiteboardNow,
      syncSolution,
      whiteboardUntouched,
    ],
  );



  /*
   * Keys the live workspace only learns after it opens.
   *
   * A blank notebook has no id until the first autosave, and a document has
   * no index status until the embed comes back. Both are what a parked tab is
   * later found by, so they are mirrored onto the record as they arrive.
   */
  useEffect(() => {
    patchTab(tab.id, { notebookId: whiteboardNotebookId });
  }, [patchTab, tab.id, whiteboardNotebookId]);

  useEffect(() => {
    patchTab(tab.id, { docId: annotateDocId, ...(annotateDocId ? { source: null } : {}) });
  }, [annotateDocId, patchTab, tab.id]);

  /*
   * Two sets on one file would otherwise be two chips reading `dp.pdf`.
   *
   * Only once the set is actually in the library: an unsaved session has no
   * label to show and no sibling to be confused with, so it keeps the file
   * name. `annotateDocLabel` falls back to "{name} — {date}", which says which
   * session it was rather than merely that it was not the first.
   */
  useEffect(() => {
    if (!annotateDocId) return;
    const meta = getAnnotateDocMeta(annotateDocId);
    if (!meta) return;
    const siblings = listAnnotateDocsByHash(meta.hash);
    patchTab(tab.id, { title: siblings.length > 1 ? annotateDocLabel(meta) : meta.name });
  }, [annotateDocId, patchTab, tab.id]);

  useEffect(() => {
    patchTab(tab.id, { indexed: docIndexStatus });
  }, [docIndexStatus, patchTab, tab.id]);

  /*
   * The prompt belongs to one chip. Switching away answers it by walking off,
   * which is an answer — leave the empty tab where it is and take the modal
   * down rather than carrying it onto whatever was opened instead. A retry that
   * actually loaded also answers it: the workspace is no longer empty.
   */
  const activeTabRecord = tab;
  const activeWebTab = activeTabRecord.kind === "web" ? activeTabRecord : undefined;

  /* Which header icon is the live workspace, and so wears the pressed form. */
  const webPadLive = tab.kind === "web";
  /*
   * Browsing or annotating — a web tab is one or the other, never both.
   *
   * Live is a native webview over the pane: the real page, its own JavaScript,
   * its own CSS. Nothing of ours can be drawn on top of a native surface and
   * nothing can reach into it for a text range, so ink and marks are impossible
   * while it is showing. Freezing serialises it into a document, which is what
   * makes those possible and what costs the fidelity. Keeping them as two
   * states is the only honest way to have both.
   *
   * Desktop only: Android has no child webview, so those tabs stay frozen.
   */
  const [webLive, setWebLive] = useState(false);
  const canBrowseLive = webPadLive && isTauriRuntime();
  const docPadLive = Boolean(problem && isAnnotate(problem) && annotateSource?.docType !== "web" && tab.kind !== "web");
  const boardPadLive = Boolean(problem && isWhiteboard(problem));


  const canvasLoading =
    boardPreparing ||
    switchMotion !== "idle" ||
    browseMotion === "busy" ||
    browseMotion === "exit" ||
    browseMotion === "done" ||
    (holdBrowseOverlay && boardPreparing);

  /** The address bar's own idea of "a page is on its way". */
  const webLoading = busy !== null || canvasLoading;

  /*
   * Tab switch uses `.lc-switching` on the canvas. Putting that on
   * `chrome.loading` also stamped `.lc-app-loading`, which blurs the header
   * for the length of the swap.
   */
  const shellLoading =
    boardPreparing ||
    browseMotion === "busy" ||
    browseMotion === "exit" ||
    browseMotion === "done" ||
    (holdBrowseOverlay && boardPreparing);

  const groupedCoachThreads = useMemo(() => groupThreads(agentMessages), [agentMessages]);
  const openFootnote = useMemo(
    () => annotateFootnotes.find((entry) => entry.id === openFootnoteId) ?? null,
    [annotateFootnotes, openFootnoteId],
  );
  /**
   * The turns of one saved thread, asked for by the card as it opens them.
   *
   * A footnote can hold several conversations now, and which one is on screen
   * is the card's business — so this is a lookup rather than a precomputed
   * list for whichever thread the mark happens to name first.
   */
  const footnoteThreadMessages = useCallback(
    (rootId: string) => visibleThreadMessages(agentMessages, rootId, groupedCoachThreads),
    [agentMessages, groupedCoachThreads],
  );
  const footnoteNumbers = useMemo(() => numberFootnotes(annotateFootnotes), [annotateFootnotes]);
  const footnoteThreadRoots = useMemo(() => {
    const roots = new Set<string>();
    for (const entry of annotateFootnotes) {
      if (entry.threadRootId) roots.add(entry.threadRootId);
      for (const thread of entry.threads ?? []) roots.add(thread.rootId);
    }
    return roots;
  }, [annotateFootnotes]);

  const openCoachFootnoteThread = useCallback(
    (rootId: string) => {
      const footnote =
        annotateFootnotes.find(
          (entry) =>
            entry.threadRootId === rootId ||
            (entry.threads ?? []).some((thread) => thread.rootId === rootId),
        ) ?? null;
      if (footnote) {
        setFootnoteOpenThreadId(rootId);
        openFootnoteOverview(footnote.id, null);
        return;
      }
      setCoachFocusThread({ token: Date.now(), rootId });
    },
    [annotateFootnotes, openFootnoteOverview],
  );

  /*
   * Excalidraw cannot measure a box that is not laid out.
   *
   * A parked board sits at `display: none`, so a window resize while it was
   * away never reached it. Coming back, the size is right again but nothing
   * has told it so — hence the nudge, on the frame after it is painted. The
   * camera is untouched: this is a re-measure, not a re-fit, so a tab comes
   * back exactly where it was left.
   */
  const wasShowingRef = useRef(showing);
  const wasSplitRoleRef = useRef(splitRole);
  useEffect(() => {
    const returning = showing && !wasShowingRef.current;
    const splitChanged = showing && splitRole !== wasSplitRoleRef.current;
    wasShowingRef.current = showing;
    wasSplitRoleRef.current = splitRole;
    if (!returning && !splitChanged) return;
    // Same settle ladder as rotate: the first frame is often still full-width.
    const delays = [0, 80, 200, 400, 700];
    const ids = delays.map((ms) =>
      window.setTimeout(() => {
        boardRef.current?.nudgeViewportFit();
        window.dispatchEvent(new Event("resize"));
      }, ms),
    );
    return () => {
      for (const id of ids) window.clearTimeout(id);
    };
  }, [showing, splitRole]);

  /*
   * A parked save used to leave switchMotion busy / preparing on. Focusing the
   * partner in a split then replayed the load theatre over a board that was
   * already there. Skip that when nothing is actually loading.
   */
  useEffect(() => {
    if (!showing) return;
    if (!problem) return;
    if (workspaceLoadActive) return;
    setSwitchMotion((motion) => (motion === "idle" ? motion : "idle"));
    setBoardPreparing((on) => (on ? false : on));
  }, [problem, showing, workspaceLoadActive]);

  /*
   * Mounting *is* opening.
   *
   * The shell writes the record and renders a workspace under `key={tab.id}`;
   * this is where that record gets read. It runs once, because the key is the
   * identity — a different tab is a different instance, not this one being
   * asked to become something else. Home has nothing to load, and says so.
   */
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (tab.kind === "home") return;
    void openTabWorkspace(tab);
    // Deliberately mount-only: see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * What the shell can ask of a workspace it is about to unmount.
   *
   * Switching tabs unmounts this instance, and only this instance knows what
   * is unsaved in it — so the shell asks rather than reaching in. `park`
   * commits quietly; `leave` is the save / discard / cancel dialog and answers
   * whether it may proceed.
   */
  const abortLoad = useCallback(async () => {
    workspaceLoadGenRef.current += 1;
    setBusy(null);
    setWorkspaceLoadActive(false);
    const browseOverlay = holdBrowseOverlay || browseMotion !== "idle";
    const switchOverlay = switchMotion !== "idle" || boardPreparing;
    if (browseOverlay) setBrowseMotion("done");
    if (switchOverlay && !browseOverlay) setSwitchMotion("done");
    if (browseOverlay || switchOverlay) setBoardPreparing(true);
    // Same check-hold as a finished load, even if the spinner had not painted
    // yet — Cancel must not snap Home in one frame.
    await waitMs(doneHoldMs());
    setBrowseMotion("idle");
    setSwitchMotion("idle");
    setHoldBrowseOverlay(false);
    setBoardPreparing(false);
    setShellLoadActive(false);
  }, [
    boardPreparing,
    browseMotion,
    holdBrowseOverlay,
    setBrowseMotion,
    setHoldBrowseOverlay,
    setShellLoadActive,
    switchMotion,
  ]);

  const showHomeChooser = useCallback(() => {
    setPracticeOpen(false);
    setWhiteboardEntryOpen(false);
    setAnnotateEntryOpen(false);
  }, []);

  useEffect(() => {
    setWorkspaceApi(tab.id, {
      park: () => new Promise<void>((resolve) => parkWorkspace(() => resolve())),
      leave: () => new Promise<boolean>((resolve) => leaveProblem(() => resolve(true))),
      abortLoad,
      showHomeChooser: tab.kind === "home" ? showHomeChooser : undefined,
    });
    return () => setWorkspaceApi(tab.id, null);
  }, [abortLoad, leaveProblem, parkWorkspace, setWorkspaceApi, showHomeChooser, tab.id, tab.kind]);

  /*
   * Only the workspace on screen wears the app's chrome. The classes live on
   * the shell's wrapper because they are global — header height, agent column
   * width — so with more than one mounted they can only come from one of them.
   */
  useEffect(() => {
    if (!active) return;
    setChrome({
      problem: Boolean(problem),
      pad: Boolean(problem && isLocalPad(problem)),
      agentOpen: coachOpen && Boolean(problem),
      loading: shellLoading,
      busy: busy !== null,
      loadActive: workspaceLoadActive,
      docIndex: {
        status: docIndexStatus,
        meta: docIndexMeta,
        error: docIndexError,
        onIndex: indexInputsRef.current ? indexOpenDocument : null,
      },
    });
  }, [
    active,
    busy,
    shellLoading,
    coachOpen,
    docIndexError,
    docIndexMeta,
    docIndexStatus,
    indexOpenDocument,
    problem,
    setChrome,
    workspaceLoadActive,
  ]);

  return (
    <>
      {/*
        This workspace's own chrome, portaled into the shell's header. The DOM
        lands where it always did; the React tree stays here, which is what
        keeps every control wired to this tab's state.
      */}
      {active && headerSlots.left ? createPortal(<>
          {tabsRef.current.tabs.length === 1 && !practiceOpen && (
            <span className="lc-muted lc-browse-hint">choose a mode to start</span>
          )}
          {problem && !isLocalPad(problem) ? (
            <div className="lc-problem-nav" role="group" aria-label="Problem">
              <button
                type="button"
                className="lc-icon"
                title={
                  navigateBySession && (session?.queue?.length ?? 0) > 0
                    ? "Previous in session queue"
                    : "Previous in problem bank"
                }
                aria-label="Previous problem"
                disabled={!canStepPrev || busy !== null}
                onClick={() => leaveProblem(() => void stepProblem(-1))}
              >
                ‹
              </button>
              <button
                type="button"
                className="lc-icon"
                title={
                  navigateBySession && (session?.queue?.length ?? 0) > 0
                    ? "Next in session queue"
                    : "Next in problem bank"
                }
                aria-label="Next problem"
                disabled={!canStepNext || busy !== null}
                onClick={() => leaveProblem(() => void stepProblem(1))}
              >
                ›
              </button>
            </div>
          ) : null}
      </>, headerSlots.left) : null}
      {active && headerSlots.center ? createPortal(<>
          {problem && !isLocalPad(problem) && (
            <div className="lc-actions">
              <button
                type="button"
                className="lc-secondary"
                onClick={() => void runTests()}
                disabled={busy !== null || canvasLoading}
                title="Run the sample tests"
                aria-label="Run tests"
              >
                <span className="lc-label-long">Run tests</span>
                <span className="lc-label-short" aria-hidden>
                  ▶
                </span>
              </button>
              <button
                type="button"
                className="lc-secondary"
                onClick={() => void submitSolution()}
                disabled={busy !== null || canvasLoading}
                title="Sync solution, run all tests, and continue if they pass"
                aria-label="Submit"
              >
                <span className="lc-label-long">Submit</span>
                <span className="lc-label-short" aria-hidden>
                  ✓
                </span>
              </button>
              <button
                type="button"
                className="lc-secondary lc-desktop-only"
                disabled={busy !== null || canvasLoading}
                onClick={() => void openInIde()}
                title="Open solution.py in Cursor / VS Code"
              >
                Open in IDE
              </button>
            </div>
          )}
      </>, headerSlots.center) : null}
      {active && headerSlots.right ? createPortal(<>
          {/*
            Globe, then the file icon, then paper. Tap opens google.com as a
            snapshot pad; hold is the same annotate library.

            With a workspace already open these no longer disappear — they
            spawn a tab beside it. The one icon matching what is on screen
            keeps its pressed form, where tap is Save and hold is the library.
          */}
          {!webPadLive && (
            <HoldButton
              label="Web"
              ariaLabel="Web pad: tap for a new page, hold for recent pages"
              className="lc-icon lc-tip-target lc-hold-icon"
              dataTip="Web — tap for a new page, hold for recent"
              dataTipPlacement="bottom"
              disabled={busy !== null || canvasLoading}
              fillIndeterminate={spawning === "web"}
              onTap={() => {
                setSpawning("web");
                void openWebPage(WEB_HOME, { newTab: true });
              }}
              onConfirm={() => {
                setEntryKind("web");
                setAnnotateEntryOpen(true);
              }}
            >
              <svg
                className="lc-icon-svg"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </HoldButton>
          )}
          {/*
            Document icon, left of the scratchpad's paper: tap picks a file to
            annotate, hold opens the library. Same split as its neighbour.
          */}
          {!docPadLive && (
            <HoldButton
              label="Document"
              ariaLabel="Document pad: tap to open a file, hold for recent documents"
              className="lc-icon lc-tip-target lc-hold-icon"
              dataTip="Document — tap to open a .md, source file, .pdf or .epub, hold for recent"
              dataTipPlacement="bottom"
              disabled={busy !== null || canvasLoading}
              onTap={() => void pickAndOpenAnnotate()}
              onConfirm={() => {
                setEntryKind("document");
                setAnnotateEntryOpen(true);
              }}
            >
              <svg
                className="lc-icon-svg"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                {/* An "M" and a down-arrow — the markdown mark, at icon scale. */}
                <path d="M7 18v-5l2.2 2.6L11.4 13v5" />
                <path d="M14.6 13v5M12.9 16.4l1.7 1.6 1.7-1.6" />
              </svg>
            </HoldButton>
          )}
          {webPadLive && (
            <HoldButton
              label="Web"
              ariaLabel="Web documents: tap to save now, hold for save / open menu"
              className="lc-icon lc-hold-icon lc-tip-target is-active"
              dataTip="Web — tap to save, hold for menu"
              dataTipPlacement="bottom"
              pressed
              disabled={busy !== null || canvasLoading}
              onTap={() => {
                void saveAnnotateSession().then((saved) => {
                  if (saved) setNotice(`Annotations saved for “${saved.name}”.`);
                });
              }}
              onConfirm={() => {
                setEntryKind("web");
                setAnnotateEntryOpen(true);
              }}
            >
              <svg
                className="lc-icon-svg"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </HoldButton>
          )}
          {docPadLive && (
            /* Tap to save now, hold for the sheet. */
            <HoldButton
              label="Markdown"
              ariaLabel="Markdown documents: tap to save now, hold for save / open menu"
              className="lc-icon lc-hold-icon lc-tip-target is-active"
              dataTip="Markdown — tap to save, hold for menu"
              dataTipPlacement="bottom"
              pressed
              disabled={busy !== null || canvasLoading}
              onTap={() => {
                void saveAnnotateSession().then((saved) => {
                  if (saved) setNotice(`Annotations saved for “${saved.name}”.`);
                });
              }}
              onConfirm={() => setAnnotateEntryOpen(true)}
            >
              <svg
                className="lc-icon-svg lc-icon-svg-filled"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" fill="none" />
              </svg>
            </HoldButton>
          )}
          {/*
            Paper icon: tap for a blank notebook, hold for the library.
            Starting to write is the common case by a wide margin, and it was
            behind a dialog whose other option nobody wanted most of the time.
          */}
          {!boardPadLive && (
            <HoldButton
              label="Whiteboard"
              ariaLabel="Whiteboard: tap for a new notebook, hold to open the library"
              className="lc-icon lc-tip-target lc-hold-icon"
              dataTip="Whiteboard — tap for new, hold to load"
              dataTipPlacement="bottom"
              disabled={busy !== null || canvasLoading}
              onTap={() => void openWhiteboard({ fresh: true })}
              onConfirm={() => setWhiteboardEntryOpen(true)}
            >
              <svg
                className="lc-icon-svg"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M8 13h8" />
                <path d="M8 17h5" />
              </svg>
            </HoldButton>
          )}
          {boardPadLive && (
            /*
              Tap to save now, hold for the sheet.

              An explicit save was three taps through a menu — enough friction
              that it stops happening and the autosave gets leaned on instead.
              One tap on the header is the short path; hold opens save / load.
            */
            <HoldButton
              label="Whiteboard"
              ariaLabel="Whiteboard: tap to save now, hold for save / load menu"
              className="lc-icon lc-hold-icon lc-tip-target is-active"
              dataTip="Whiteboard — tap to save, hold for menu"
              dataTipPlacement="bottom"
              pressed
              disabled={busy !== null || canvasLoading}
              onTap={() => void saveWhiteboardNow()}
              onConfirm={() => setWhiteboardEntryOpen(true)}
            >
              <svg
                className="lc-icon-svg lc-icon-svg-filled"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" fill="none" />
              </svg>
            </HoldButton>
          )}
          <button
            type="button"
            className="lc-icon lc-tip-target"
            aria-label="Settings"
            data-tip="Settings — paths, LLM, serve"
            data-tip-placement="bottom"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              className="lc-icon-svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          {/*
            Always in the header, even with nothing to talk to.

            Home has no problem, so the chip used to unmount there and take its
            width with it — every tab chip in the strip resized on the way in
            and out, which reads as the strip flickering rather than as one
            button leaving. It keeps its slot and goes invisible instead.
          */}
          <button
            type="button"
            className={[
              coachOpen
                ? "lc-secondary lc-agent-toggle lc-agent-toggle-open lc-tip-target"
                : "lc-secondary lc-agent-toggle lc-tip-target",
              problem ? "" : "is-vacant",
              llmLink === "online" && "lc-agent-toggle-llm-on",
              llmLink === "offline" && "lc-agent-toggle-llm-off",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-expanded={problem ? coachOpen : undefined}
            aria-controls={problem ? "lc-agent-panel" : undefined}
            aria-hidden={problem ? undefined : true}
            tabIndex={problem ? undefined : -1}
            disabled={!problem}
            data-tip={
              !problem
                ? undefined
                : llmLink === "online"
                  ? "Agent — LLM online"
                  : llmLink === "offline"
                    ? "Agent — LLM offline"
                    : "Agent"
            }
            data-tip-placement="bottom"
            onClick={() => setCoachOpen((current) => !current)}
          >
            <span className="lc-agent-live-dot" aria-hidden />
            Agent
          </button>
      </>, headerSlots.right) : null}
      {active && headerSlots.chrome ? createPortal(<>
      {/*
        The pages are in the header strip with everything else now, so what is
        left under it is the address bar itself — back, forward, the URL, and
        the `+` that asks for another page, which stays here beside the address
        it is about rather than becoming a bare `+` on a strip of mixed kinds.
      */}
      {webPadLive && (
        <form
          className="lc-web-omnibox"
          onSubmit={(event) => {
            event.preventDefault();
            void openWebPage(webUrl);
          }}
        >
          <div className="lc-web-omnibox-row">
            <button
              type="button"
              className="lc-icon"
              aria-label="Back"
              disabled={busy !== null || !activeWebTab || !canStepWeb(activeWebTab, -1)}
              onClick={() => stepWebTab(-1)}
            >
              ‹
            </button>
            {/*
              Reload and Stop are the same button, because they are the same
              slot in the same moment: a page is either loading or it is not, so
              one of the two is always the wrong thing to offer. It lives
              between the arrows rather than after them so it never moves — the
              arrows grey out constantly and a control that shuffles when its
              neighbours disable is a control you have to look for.
            */}
            <button
              type="button"
              className={webLoading ? "lc-icon lc-web-stop" : "lc-icon"}
              aria-label={webLoading ? "Stop loading" : "Reload page"}
              title={webLoading ? "Stop" : "Reload"}
              onClick={() => {
                if (webLoading) void abortLoad();
                else void openWebPage(webUrl);
              }}
            >
              {webLoading ? "✕" : "↻"}
            </button>
            <button
              type="button"
              className="lc-icon"
              aria-label="Forward"
              disabled={busy !== null || !activeWebTab || !canStepWeb(activeWebTab, 1)}
              onClick={() => stepWebTab(1)}
            >
              ›
            </button>
            {/*
              Go rides inside the field, the way an address bar has for years —
              it is the same gesture as pressing Enter, so it belongs with the
              text rather than beside it as a button the width of a word.
            */}
            <div className="lc-web-address">
              {/*
                Reader, on the address — where Safari puts it, and where it
                belongs: it is a statement about *this URL*, not a mode of the
                app. It used to be two chips further along the bar saying "full
                page" or "raw page", which describe an implementation and read
                as error badges.

                Lit means you are reading the extracted article. Dim means the
                page is not one, or extraction failed; pressing it tries again.
              */}
              {webHtmlSource && (
                <button
                  type="button"
                  className={
                    webHtmlSource === "reader"
                      ? "lc-web-reader-toggle is-on"
                      : "lc-web-reader-toggle"
                  }
                  aria-pressed={webHtmlSource === "reader"}
                  aria-label={
                    webHtmlSource === "reader" ? "Reader view" : "Try reader view"
                  }
                  title={
                    webHtmlSource === "reader"
                      ? "Reader view — the article, without the page around it"
                      : webHtmlSource === "fetch"
                        ? `${
                            webHtmlNote
                              ? `The live capture failed — ${webHtmlNote}. `
                              : "The live capture was unavailable. "
                          }This is the raw HTML. Tap to try again.`
                        : "Not an article, so the whole page was kept. Tap to try reader view."
                  }
                  onClick={() => void openWebPage(webUrl)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 6h7M4 10h7M4 14h5" />
                    <path d="M14 6h6M14 10h6M14 14h6M14 18h6" />
                  </svg>
                </button>
              )}
              <input
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={webUrl}
                aria-label="Page address"
                onChange={(event) => setWebUrl(event.target.value)}
              />
              <button
                type="submit"
                className="lc-web-go"
                aria-label="Go"
                title="Go"
                disabled={busy !== null || canvasLoading}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 12h14" />
                  <path d="m12 6 6 6-6 6" />
                </svg>
              </button>
            </div>
            {/*
              Live page, or a copy you can write on. One button, an icon like
              its neighbours rather than a word in a pill — the pen says which
              of the two you are in, because only one of them accepts ink.
            */}
            {canBrowseLive && (
              <button
                type="button"
                className={webLive ? "lc-icon lc-web-live-toggle is-live" : "lc-icon lc-web-live-toggle"}
                aria-pressed={webLive}
                aria-label={webLive ? "Freeze this page" : "Browse the live page"}
                title={
                  webLive
                    ? "Live page. Freeze it to write on it."
                    : "A frozen copy you can write on. Tap to go back to the live page."
                }
                onClick={() => {
                  if (webLive) void freezeLivePage();
                  else setWebLive(true);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {webLive ? (
                    // Snowflake-ish: freeze what is on screen.
                    <>
                      <path d="M12 3v18M5 7l14 10M19 7L5 17" />
                    </>
                  ) : (
                    // Globe: go back to the live page.
                    <>
                      <circle cx="12" cy="12" r="8" />
                      <path d="M4 12h16M12 4a14 14 0 0 1 0 16a14 14 0 0 1 0-16" />
                    </>
                  )}
                </svg>
              </button>
            )}
            {/*
              Indexing a page is a decision, not a side effect of having looked
              at it — see the open path. This is where the decision is made.
            */}
            <button
              type="button"
              className={
                docIndexStatus === "indexed" ? "lc-icon is-active" : "lc-icon"
              }
              aria-label={
                docIndexStatus === "indexed"
                  ? "This page is in the index"
                  : "Index this page"
              }
              title={
                docIndexStatus === "indexed"
                  ? "Indexed — the agent can search this page"
                  : docIndexStatus === "indexing"
                    ? "Indexing…"
                    : "Index this page for the agent"
              }
              disabled={
                busy !== null ||
                canvasLoading ||
                docIndexStatus === "indexing" ||
                docIndexStatus === "indexed"
              }
              onClick={indexOpenDocument}
            >
              {docIndexStatus === "indexing" ? "…" : "⌸"}
            </button>
          </div>
        </form>
      )}
      </>, headerSlots.chrome) : null}
        <div
          className={[
            "lc-canvas-wrap",
            // Mounted but not on screen: takes no layout, keeps its board.
            !showing && "lc-canvas-parked",
            // Painted over the workspace arriving underneath — Home's overlay
            // sliding away is the only thing that does this.
            showing && !active && tab.kind === "home" && "lc-canvas-over",
            splitRole === "a" && "is-split-a",
            splitRole === "b" && "is-split-b",
            entering && "lc-entering",
            canvasLoading && "lc-canvas-loading",
            boardPreparing && "lc-canvas-preparing",
            !problem && "lc-canvas-idle",
            (switchMotion === "busy" || switchMotion === "done") && "lc-switching",
            // Lifts the ink layer over the dock — see the rule in styles.css.
            annotateCode && "lc-annotating-code",
            pdfFilmOpen && pdfNav && pdfNav.count >= 2 && "lc-has-pdf-film",
            canBrowseLive && webLive && "lc-canvas-live-web",
          ]
            .filter(Boolean)
            .join(" ")}
          onPointerDownCapture={() => {
            if (!active && showing) focusTab(tab.id);
          }}
        >
          {/*
            The live page sits in front of the board, not instead of it.

            The board stays mounted underneath with its ink and marks intact, so
            freezing is a state change rather than a reload. A native webview
            paints above all HTML regardless of z-index, so the placeholder's
            only job is to say where.
          */}
          {canBrowseLive && webLive && annotateSource?.docType === "web" && (
            <LiveWebPane
              url={annotateSource.name}
              visible={Boolean(showing && active)}
              onError={(message) => {
                setError(message);
                setWebLive(false);
              }}
            />
          )}
          {tab.kind !== "home" && tab.kind !== "explore" ? (
          <Board
            ref={boardRef}
            themeId={themeId}
            onThemePick={setThemeId}
            readingSize={readingSize}
            interactive={Boolean(
              showing &&
              problem &&
                switchMotion === "idle" &&
                !boardPreparing &&
                !holdBrowseOverlay &&
                browseMotion !== "busy" &&
                browseMotion !== "exit" &&
                browseMotion !== "done",
            )}
            chromeEnabled={active || splitKeepChrome}
            chromeHost={headerSlots.boardChrome}
            onCodeSlot={onCodeSlot}
            transparentCanvas={Boolean(
              problem &&
                (isAnnotate(problem) ||
                  (!isLocalPad(problem) && activeRegion === "constraints")),
            )}
            docPaper={Boolean(
              problem &&
                (isAnnotate(problem) ||
                  isWhiteboard(problem) ||
                  (!isLocalPad(problem) &&
                    (activeRegion === "constraints" || activeRegion === "code"))),
            )}
            annotateToggle={Boolean(problem)}
            editToggle={annotateOwned}
            editing={editMarkdown}
            onToggleEdit={toggleEditMarkdown}
            onMdFormat={(kind) => mdEditorRef.current?.format(kind)}
            linkToggle={Boolean(problem) && !editMarkdown}
            linking={linkMode}
            onToggleLink={() => {
              // Mutually exclusive with the document highlighter: both take
              // the pointer over the page.
              setHighlighting(false);
              setLinkMode((on) => !on);
            }}
            onClearDocMarks={() => setAnnotateFootnotes([])}
            onAnnotateCodeChange={setAnnotateCode}
            // Ruled lines under somebody else's typography would be noise.
            linedPaperToggle={Boolean(problem) && !isAnnotate(problem)}
            mobileRegion={
              problem
                ? isWhiteboard(problem)
                  ? whiteboardPageId(whiteboardPageIndex)
                  : isAnnotate(problem)
                    ? ANNOTATE_REGION
                    : activeRegion
                : null
            }
            focusRegion={null}
            bottomCenter={
              problem && !isLocalPad(problem) ? (
                <RegionPager
                  active={activeRegion}
                  onPick={setActiveRegion}
                  disabled={busy !== null || boardPreparing}
                />
              ) : null
            }
            pageTitle={null}
            pageContentHeight={
              problem && isAnnotate(problem)
                ? annotatePageHeight(annotateHeight)
                : problem &&
                    !isLocalPad(problem) &&
                    !isAnnotate(problem) &&
                    activeRegion === "constraints"
                  ? annotatePageHeight(statementHeight)
                  : null
            }
            codeContentHeight={
              // Same gate as before this session — code page only; not mixed
              // into statement / md-ink pageContentHeight.
              problem &&
              !isLocalPad(problem) &&
              codeContentHeight &&
              activeRegion === "code"
                ? codeContentHeight + CODE_PAGE_TAIL
                : null
            }
            selectableContent={Boolean(
              problem &&
                ((isAnnotate(problem) && annotateSource) ||
                  (!isLocalPad(problem) && !isAnnotate(problem))),
            )}
            textMarkSelecting={Boolean(openFootnote)}
            onMarksSlot={setMarksSlot}
            onHighlightingChange={setHighlighting}
            pageContent={
              problem && isAnnotate(problem) && annotateSource && editMarkdown ? (
                <AnnotateMarkdownEditor
                  ref={mdEditorRef}
                  value={editBuffer}
                  onChange={setEditBuffer}
                  readingSize={readingSize}
                  onMeasure={onMdInkMeasure}
                />
              ) : problem && isAnnotate(problem) && annotateSource ? (
                <DocSelectionLayer
                  enabled={!annotateCode || Boolean(openFootnote) || highlighting}
                  highlighting={highlighting}
                  marksHost={marksSlot}
                  footnotes={annotateFootnotes}
                  onAnnotate={onDocAnnotate}
                  onCopy={onDocCopy}
                  onSearch={onDocSearch}
                  onMark={highlighting ? onDocMark : undefined}
                  onOpenFootnote={onOpenFootnote}
                  onRemoveFootnote={onRemoveFootnote}
                  subMarkMode={openFootnote ? subMarkMode : null}
                  subMarkParent={openFootnote}
                  onAddSubMark={onAddSubMark}
                  hoveredSubMarkId={hoveredSubMarkId}
                  subMarkPaintTheme={subMarkMode === "underline" ? subMarkPaintTheme : null}
                  onSubMarkLiveStart={() => setActiveSubMarkId(null)}
                >
                  {annotateSource.docType === "pdf" && annotateSource.bytes ? (
                    <PdfDocument
                      bytes={annotateSource.bytes}
                      frameWidth={annotatePageWidth}
                      onMeasure={onMdInkMeasure}
                      onNav={setPdfNav}
                      onThumbRenderer={onPdfThumbRenderer}
                      selectable={!annotateCode || Boolean(openFootnote) || highlighting}
                      onError={setError}
                    />
                  ) : annotateSource.docType === "epub" && annotateSource.bytes ? (
                    <EpubDocument
                      bytes={annotateSource.bytes}
                      onMeasure={onMdInkMeasure}
                      selectable={!annotateCode || Boolean(openFootnote) || highlighting}
                      onError={setError}
                    />
                  ) : annotateSource.docType === "code" ? (
                    <CodeDocument
                      source={annotateSource.text}
                      language={languageForName(annotateSource.name)}
                      onMeasure={onMdInkMeasure}
                      selectable={!annotateCode || Boolean(openFootnote) || highlighting}
                    />
                  ) : annotateSource.docType === "web" ? (
                    <WebDocument
                      html={annotateSource.text}
                      url={annotateSource.name}
                      source={webHtmlSource ?? undefined}
                      note={webHtmlNote ?? undefined}
                      onMeasure={onMdInkMeasure}
                      selectable={!annotateCode || Boolean(openFootnote) || highlighting}
                      onNavigate={(href) => void openWebPage(href)}
                    />
                  ) : (
                    <AnnotateDocument
                      source={annotateSource.text}
                      onMeasure={onMdInkMeasure}
                      selectable={!annotateCode || Boolean(openFootnote) || highlighting}
                    />
                  )}
                </DocSelectionLayer>
              ) : problem &&
                !isLocalPad(problem) &&
                !isAnnotate(problem) &&
                activeRegion === "constraints" ? (
                <DocSelectionLayer
                  enabled={!annotateCode || Boolean(openFootnote) || highlighting}
                  highlighting={highlighting}
                  marksHost={marksSlot}
                  footnotes={annotateFootnotes}
                  onAnnotate={onDocAnnotate}
                  onCopy={onDocCopy}
                  onSearch={onDocSearch}
                  onMark={highlighting ? onDocMark : undefined}
                  onOpenFootnote={onOpenFootnote}
                  onRemoveFootnote={onRemoveFootnote}
                  subMarkMode={openFootnote ? subMarkMode : null}
                  subMarkParent={openFootnote}
                  onAddSubMark={onAddSubMark}
                  hoveredSubMarkId={hoveredSubMarkId}
                  subMarkPaintTheme={subMarkMode === "underline" ? subMarkPaintTheme : null}
                  onSubMarkLiveStart={() => setActiveSubMarkId(null)}
                >
                  <StatementDocument
                    title={titleFromSlug(problem.task_id, problem.question_id)}
                    difficulty={problem.difficulty}
                    tags={problem.tags}
                    caseCount={problem.cases?.length}
                    description={problem.problem_description}
                    onMeasure={onStatementMeasure}
                    selectable={!annotateCode || Boolean(openFootnote) || highlighting}
                  />
                </DocSelectionLayer>
              ) : null
            }
            coachFold={null}
            sheetDragLocked={mobile ? sheetDragLocked : false}
            onToggleSheetLock={mobile ? onToggleSheetLock : undefined}
            pageFilm={
              pdfNav && pdfNav.count >= 2
                ? { open: pdfFilmOpen, onToggle: togglePdfFilm }
                : null
            }
          />
          ) : null}
          {pdfFilmOpen && pdfNav && pdfNav.count >= 2 && (
            <PdfPageRail
              count={pdfNav.count}
              current={pdfNav.current}
              aspects={pdfNav.aspects}
              renderThumb={renderPdfThumb}
              onJump={(page) => boardRef.current?.scrollToPdfPage(page)}
            />
          )}
          {!problem &&
            (tab.kind === "home" ||
              // Explore rides the same overlay as Home: both are surfaces the
              // app draws itself rather than boards, so they share the layer
              // that sits over a canvas which never mounts for them.
              tab.kind === "explore" ||
              holdBrowseOverlay ||
              boardPreparing ||
              browseMotion !== "idle") && (
            <div
              className={[
                "lc-overlay",
                browseMotion === "enter" && "lc-overlay-enter",
                (browseMotion === "busy" || (holdBrowseOverlay && boardPreparing)) &&
                  "lc-overlay-busy",
                browseMotion === "exit" && "lc-overlay-exit",
                (browseMotion === "done" ||
                  (holdBrowseOverlay && boardPreparing && browseMotion === "idle")) &&
                  "lc-overlay-done",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="lc-overlay-content">
                {tab.kind === "home" && practiceOpen && FEATURE_LEETCODE ? (
                  <ProblemBrowser
                    client={client}
                    onPick={pickProblem}
                    busy={
                      busy !== null ||
                      boardPreparing ||
                      annotateEntryOpen ||
                      whiteboardEntryOpen
                    }
                    session={session}
                    offline={false}
                    themeId={themeId}
                    onThemePick={setThemeId}
                    onReady={onBrowseTableReady}
                    onStartSession={(ids, bank) => void startFreshSession(ids, bank)}
                    onResetSession={() => {
                      setResetError(null);
                      setResetOpen(true);
                    }}
                    onRandomSession={(filters) => void startRandomSession(filters)}
                  />
                ) : tab.kind === "explore" ? (
                  <ExploreWorkspace
                    nodes={[...exploreNodes, ...exploreExtra]}
                    here={hereNode}
                    themeId={themeId}
                    onThemePick={setThemeId}
                    onUnlink={(edgeId) => void deleteEdge(edgeId)}
                    onRename={(node, title) => renameGraphNode(node, title)}
                    onOpen={openLinkedNode}
                    onOpenInNewTab={openLinkedNode}
                    active={active}
                    showing={showing}
                    embedInBoardTray={embedInBoardTray}
                    // Practice is one tab, so a second chip for a problem is
                    // refused rather than hidden — the reason is worth saying.
                    canOpenInNewTab={(node) => node.type !== "practice"}
                  />
                ) : tab.kind === "home" && !holdBrowseOverlay ? (
                  <HomeChooser
                    busy={busy !== null || boardPreparing || workspaceLoadActive}
                    onPractice={() => setPracticeOpen(true)}
                    onWhiteboard={() => setWhiteboardEntryOpen(true)}
                    onAnnotate={() => setAnnotateEntryOpen(true)}
                    onBrowse={() => void openWebPage(WEB_HOME)}
                    onExplore={openExplore}
                  />
                ) : null}
              </div>
              {(browseMotion === "busy" ||
                browseMotion === "exit" ||
                browseMotion === "done" ||
                (holdBrowseOverlay && boardPreparing)) && (
                <WorkspaceLoadStatus
                  /*
                   * Checkmark when the motion says done. Preparing is cleared
                   * inside finishLoadingTransition *before* this beat — do not
                   * AND `!boardPreparing` here or the hold never shows a check.
                   */
                  done={browseMotion === "done"}
                  themeId={themeId}
                />
              )}
            </div>
          )}
          {problem && (switchMotion === "busy" || switchMotion === "done") && (
            <WorkspaceLoadStatus done={switchMotion === "done"} themeId={themeId} />
          )}
          {/* Monaco docks into the code frame — and on mobile that frame only
              exists on its own page, so the dock is mounted nowhere else. */}
          {problem && !isLocalPad(problem) && activeRegion === "code" && (() => {
            const slot = codeSlot ?? lastCodeSlotRef.current;
            if (!slot || slot.width <= 24 || slot.height <= 24) return null;
            const visible = Boolean(codeSlot);
            return (
              <div
                className={[
                  "lc-code-dock",
                  !visible && "lc-code-dock-offscreen",
                  // The pen cannot reach the ink layer through an editor that
                  // is still claiming every pointer that lands on it.
                  annotateCode && "lc-code-dock-annotating",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  left: slot.left,
                  top: slot.top,
                  width: slot.width,
                  height: slot.height,
                  ["--lc-code-zoom" as string]: String(slot.zoom ?? 1),
                }}
                // Excalidraw listens for keys on document; keep them in the dock.
                onKeyDown={(event) => event.stopPropagation()}
                onKeyUp={(event) => event.stopPropagation()}
              >
                <PseudocodeEditor
                  key={problem.task_id}
                  value={pseudocode}
                  onChange={setPseudocode}
                  themeId={themeId}
                  zoom={slot.zoom ?? 1}
                  readingSize={readingSize}
                  defaultOpen
                  variant="dock"
                  onCodeHeight={setCodeContentHeight}
                />
              </div>
            );
          })()}
        </div>
      {active && headerSlots.agentPanel ? createPortal(<>
        {problem && !canvasLoading && (
          <AgentSidePanel
            open={coachOpen}
            mode={mode}
            onModeChange={setMode}
            onOpenChange={setCoachOpen}
            sheetDragLocked={sheetDragLocked}
            busy={busy !== null}
            error={error}
            thinking={busy !== null || thinking}
            thinkingPhase={coachPhase}
            messages={agentMessages}
            askOnly={isLocalPad(problem)}
            agentSurface={isLocalPad(problem) ? "pad" : "problem"}
            allowAnnotations={!isWhiteboard(problem)}
            documentPresets={isAnnotate(problem)}
            quoteSeed={coachQuoteSeed}
            focusThread={coachFocusThread}
            attachedMarks={attachedFootnoteIds.flatMap((id) => {
              const mark = annotateFootnotes.find((entry) => entry.id === id);
              if (!mark) return [];
              return [
                {
                  id: mark.id,
                  number: footnoteNumbers.get(mark.id),
                  title: mark.title,
                  color: mark.color,
                  palette: mark.palette,
                },
              ];
            })}
            attachedFootnotes={attachedFootnoteIds.flatMap((id) => {
              const mark = annotateFootnotes.find((entry) => entry.id === id);
              return mark ? [mark] : [];
            })}
            askClipChars={isLocalPad(problem) ? PAD_ASK_CLIP_CHARS : PROBLEM_ASK_CLIP_CHARS}
            annotationChoices={annotateFootnotes.map((mark) => ({
              id: mark.id,
              number: footnoteNumbers.get(mark.id),
              title: mark.title,
              color: mark.color,
              palette: mark.palette,
            }))}
            onRemoveAttached={(id) =>
              setAttachedFootnoteIds((current) => current.filter((entry) => entry !== id))
            }
            onToggleAttached={(id) =>
              setAttachedFootnoteIds((current) =>
                current.includes(id)
                  ? current.filter((entry) => entry !== id)
                  : [...current, id],
              )
            }
            footnoteThreadRoots={footnoteThreadRoots}
            onOpenFootnoteThread={openCoachFootnoteThread}
            onThreadChange={(rootId) => {
              threadRootIdRef.current = rootId;
            }}
            onSend={sendCoachChat}
            onRequestBridge={(messageId) => {
              revealForMessageIdRef.current = messageId;
              setRevealError(null);
              setRevealOpen(true);
            }}
            onToggleDrawing={toggleDrawing}
            onDrawingFrame={showDrawingFrame}
          >
            {AMBIENT_ENABLED && mode === "ambient" && (
              <AmbientPanel
                entries={nudges}
                connected={connected}
                thinking={thinking}
                provider={ambientProvider}
                lastSkip={lastSkip}
                onAnalyzeNow={() => {
                  if (!problem) return;
                  void coachRef.current?.analyzeNow(problem.task_id, capture, probe().sceneHash);
                }}
                onReset={() => {
                  coachRef.current?.reset();
                  setNudges([]);
                  lastIdsRef.current = new Set();
                }}
              />
            )}

          </AgentSidePanel>
        )}
      </>, headerSlots.agentPanel) : null}
      {active ? (
        <>
        {openFootnote && (
          <FootnoteOverview
            workspaceLinks={workspaceLinkRows}
            onAddWorkspaceLink={hereNode ? () => setLinkPickerOpen(true) : undefined}
            onOpenWorkspaceLink={(id) => {
              const here = hereNode;
              const edge = hereEdges.find((entry) => entry.id === id);
              if (!here || !edge) return;
              openLinkedNode(sameNode(edge.from, here) ? edge.to : edge.from);
            }}
            onRemoveWorkspaceLink={removeWorkspaceLink}
            footnote={openFootnote}
            number={footnoteNumbers.get(openFootnote.id)}
            threadMessages={footnoteThreadMessages}
            anchorRect={footnoteAnchorRect}
            subMarkMode={subMarkMode}
            onSubMarkModeChange={setSubMarkMode}
            onHoverSubMark={setHoveredSubMarkId}
            subMarkPaintTheme={subMarkPaintTheme}
            onSubMarkPaintTheme={setSubMarkPaintTheme}
            activeSubMarkId={activeSubMarkId}
            onActiveSubMarkIdChange={setActiveSubMarkId}
            onClose={() => {
              setOpenFootnoteId(null);
              setFootnoteAnchorRect(null);
              setSubMarkMode(null);
              setHoveredSubMarkId(null);
              setActiveSubMarkId(null);
              setSubMarkPaintTheme(null);
              setFootnoteOpenThreadId(null);
            }}
            openThreadRootId={footnoteOpenThreadId}
            onChange={onFootnoteChange}
            onSendCoach={sendCoachFromFootnote}
            onAttachCoach={(id) => {
              setAttachedFootnoteIds((current) =>
                current.includes(id) ? current : [...current, id],
              );
              setCoachOpen(true);
            }}
            onOpenExternal={(url) => {
              void openExternalUrl(url).catch(() => {
                setError("could not hand the link to a browser on this device");
              });
            }}
          />
        )}

      {resetOpen && (
        <ConfirmDialog
          title="Reset the practice session?"
          message="The session queue and its pass / fail progress are cleared. Your saved workspaces and solutions are not touched."
          detail={
            (session?.queue?.length ?? 0) > 0
              ? `${session?.queue.length} problem${session?.queue.length === 1 ? "" : "s"} queued · ${session?.stats?.passed ?? 0} passed · ${session?.stats?.failed ?? 0} failed`
              : undefined
          }
          confirmLabel="Reset"
          cancelLabel="Keep session"
          pending={resetPending}
          error={resetError}
          onConfirm={() => void resetSession()}
          onCancel={() => {
            if (resetPending) return;
            setResetOpen(false);
            setResetError(null);
          }}
        />
      )}

      {revealOpen && problem && (
        <RevealDialog
          taskId={problem.task_id}
          onConfirm={() => void confirmReveal("bridge")}
          onConfirmLazy={() => void confirmReveal("lazy")}
          onCancel={() => {
            if (revealPending) return;
            setRevealOpen(false);
            revealForMessageIdRef.current = null;
          }}
          pending={revealPending}
          error={revealError}
        />
      )}

      <TestResultsModal
        tests={tests}
        kind={lastRunKind}
        onClose={() => setTests(null)}
        onNext={() => {
          setTests(null);
          leaveProblem(() => void stepProblem(1));
        }}
        onRandom={() => {
          setTests(null);
          leaveProblem(() => void pickRandomProblem());
        }}
        onBrowse={() => {
          setTests(null);
          // Home is a tab, so this parks the attempt rather than ending it —
          // unlike Next / Random, which move on from the problem.
          focusTab(HOME_TAB_ID);
        }}
        canNext={canStepNext}
      />



      {/*
        * Which annotation set — asked over the loading board, mid-open.
        *
        * Rendered last so it sits above the leave dialog and the entry dialog:
        * an open that is waiting on this question cannot proceed until it is
        * answered, so nothing else on screen should be able to take the tap.
        */}
      {linkMode && hereNode && (
        <LinkStrokeOverlay
          marks={pageLinkChips()}
          onSuggest={suggestLinkChips}
          onResolve={resolveLinkHits}
          onNotice={setNotice}
          onCancel={() => setLinkMode(false)}
          onCommit={(originId, target) => {
            const here = hereNode;
            const mark = annotateFootnotesRef.current.find((entry) => entry.id === originId);
            /*
             * A suggestion is a passage, not a workspace — it has no node of
             * its own to point at, so the edge lands on this pad's own text
             * and the chip's label is what names it. A mark-to-mark link is
             * two places in one document, which the graph draws as a self
             * edge on that document.
             */
            void putEdge(
              makeEdge(
                { ...here, title: mark?.excerpt?.slice(0, 40) ?? target.label ?? here.title },
                { ...here, title: target.label },
                "ink",
              ),
            ).then(refreshHereEdges);
            setNotice(`Linked “${mark?.excerpt?.slice(0, 40) ?? originId}” to “${target.label}”.`);
            setLinkMode(false);
          }}
        />
      )}

      {linkPickerOpen && hereNode && (
        <WorkspaceLinkPicker
          fromTitle={hereNode.title ?? "this workspace"}
          targets={linkTargets}
          onPick={addWorkspaceLink}
          onCancel={() => setLinkPickerOpen(false)}
        />
      )}

      {sidecarChoice && (
        <SidecarChooser
          docName={sidecarChoice.docName}
          matches={sidecarChoice.matches}
          onChoose={(choice) => {
            const pending = sidecarChoice;
            setSidecarChoice(null);
            pending.resolve(choice);
          }}
        />
      )}

      {annotateEntryOpen && (
        <AnnotateDialog
          mode="entry"
          kind={entryKind}
          pending={busy !== null || boardPreparing}
          allowSave={Boolean(problem && isAnnotate(problem))}
          snapshotKey={annotateDocId}
          onRestoreTrash={(id) => restoreTrashedPad(client, "annotate", id)}
          onDelete={(id) =>
            deletePadEverywhere(client, "annotate", id)
          }
          onChoose={(choice, docId) => {
            if (choice === "save") {
              setAnnotateEntryOpen(false);
              void saveAnnotateSession().then((saved) => {
                if (saved) setNotice(`Annotations saved for “${saved.name}”.`);
              });
              return;
            }
            if (choice === "export") {
              setAnnotateEntryOpen(false);
              exportAnnotateAnnotations();
              return;
            }
            if (choice === "import") {
              setAnnotateEntryOpen(false);
              void importMdInkAnnotations();
              return;
            }
            if (choice === "snapshot" && docId) {
              setAnnotateEntryOpen(false);
              // The open set's id, not the file's hash — two sets on one file
              // each keep their own 2h/24h/7d, and the hash names neither.
              const setId = annotateDocIdRef.current;
              if (setId) void restorePadSnapshot("annotate", setId, docId as PadSnapshotTier);
              return;
            }
            if (choice === "page") {
              setAnnotateEntryOpen(false);
              setSpawning("web");
              void openWebPage(WEB_HOME, { newTab: true });
              return;
            }
            if (choice === "new") {
              setAnnotateEntryOpen(false);
              // `docId` carries the title on this branch — the dialog reuses
              // the same second argument for whatever the choice needs.
              void createOwnedNote(docId ?? "Untitled");
              return;
            }
            if (choice === "fork") {
              setAnnotateEntryOpen(false);
              // The state, not the ref: the ref's type drops `bytes`, and a
              // fork of a PDF needs them to have anything to draw over.
              const source = annotateSource;
              if (!source) return;
              /*
               * A second set on the file that is open, by handing the open a
               * brand new id. The chooser is skipped precisely because the
               * reader has already answered its question.
               */
              void openAnnotate({
                name: source.name,
                docType: source.docType,
                text: source.text,
                bytes: source.bytes ?? undefined,
                docId: freshAnnotateId(),
              });
              return;
            }
            if (choice === "recent" && docId) {
              beginPadOpen();
              void (async () => {
                try {
                  const entry = await getAnnotateDoc(docId);
                  if (!entry) {
                    setError("That document is no longer in the library.");
                    return;
                  }
                  if (!isBinaryDocType(entry.docType)) {
                    await openAnnotate({
                      name: entry.name,
                      docType: entry.docType,
                      text: entry.source,
                      docId: entry.id,
                    });
                    return;
                  }
                  /*
                   * A binary entry is only half of itself in the library JSON.
                   *
                   * Its bytes live in IndexedDB, and they can be missing —
                   * cleared storage, a device that never had them. Say so rather
                   * than opening an entry whose ink has nothing under it.
                   */
                  const bytes = await getDocBytes(entry.hash).catch(() => null);
                  if (!bytes) {
                    setError(
                      `“${entry.name}” is in the library but its file is not on this device — open it again to restore the annotations.`,
                    );
                    return;
                  }
                  await openAnnotate({
                    name: entry.name,
                    docType: entry.docType,
                    bytes,
                    docId: entry.id,
                  });
                } finally {
                  endPadOpen();
                }
              })();
              return;
            }
            void pickAndOpenAnnotate();
          }}
          onCancel={() => setAnnotateEntryOpen(false)}
        />
      )}


      {whiteboardEntryOpen && (
        <WhiteboardDialog
          mode="entry"
          pending={busy !== null || boardPreparing}
          allowSave={Boolean(problem && isWhiteboard(problem))}
          snapshotKey={whiteboardNotebookId}
          onRestoreTrash={(id) => restoreTrashedPad(client, "whiteboard", id)}
          onDelete={(id) =>
            deletePadEverywhere(client, "whiteboard", id)
          }
          onChoose={(choice, notebookId) => {
            if (choice === "save") {
              setWhiteboardEntryOpen(false);
              void saveWhiteboardNow(() => setWhiteboardEntryOpen(true));
              return;
            }
            if (choice === "load" && notebookId) {
              void openWhiteboard({ notebookId });
              return;
            }
            if (choice === "snapshot" && notebookId && whiteboardNotebookId) {
              setWhiteboardEntryOpen(false);
              void restorePadSnapshot(
                "whiteboard",
                whiteboardNotebookId,
                notebookId as PadSnapshotTier,
              );
              return;
            }
            void openWhiteboard({ fresh: true });
          }}
          onCancel={() => setWhiteboardEntryOpen(false)}
        />
      )}

      {whiteboardLibOpen && (
        <WhiteboardLibraryDialog
          onDelete={(id) =>
            deletePadEverywhere(client, "whiteboard", id)
          }
          onFreed={() => {
            setWhiteboardLibOpen(false);
            const resume = whiteboardLibResumeRef.current;
            whiteboardLibResumeRef.current = null;
            resume?.();
          }}
          onCancel={() => {
            setWhiteboardLibOpen(false);
            whiteboardLibResumeRef.current = null;
          }}
        />
      )}
        </>
      ) : null}

      {/*
        Leaving is asked wherever you are, not only on the tab being left.

        These used to sit inside the `active` gate, so closing a tab you were
        not looking at set the state, rendered nothing, and left `leave()`
        unresolved — the close silently did nothing, and the only way to find
        out why was to switch to that tab and watch the prompt appear there. A
        question about a document is still a question when the document is in
        another tab; more so, because otherwise the close looks broken rather
        than blocked.
      */}
      {leaving && problem && isWhiteboard(problem) && (
        <WhiteboardDialog
          mode="leave"
          dirty={!whiteboardUntouched()}
          pending={leavingPending}
          exiting={leavingPhase === "exit"}
          error={leavingError}
          onDelete={(id) =>
            deletePadEverywhere(client, "whiteboard", id)
          }
          onChoose={(choice, notebookId) => {
            if (choice === "load" && notebookId) {
              setLeaving(null);
              setLeavingPhase("open");
              void openWhiteboard({ notebookId });
              return;
            }
            void resolveLeave(choice === "save");
          }}
          onCancel={() => {
            if (leavingPending || leavingPhase === "exit") return;
            setLeaving(null);
            setLeavingError(null);
          }}
        />
      )}

      {leaving && problem && isAnnotate(problem) && (
        <AnnotateDialog
          mode="leave"
          dirty={!annotateUntouched()}
          docName={annotateSource?.name ?? "this document"}
          pending={leavingPending}
          exiting={leavingPhase === "exit"}
          error={leavingError}
          onDelete={(id) =>
            deletePadEverywhere(client, "annotate", id)
          }
          onChoose={(choice) => void resolveLeave(choice === "save")}
          onCancel={() => {
            if (leavingPending || leavingPhase === "exit") return;
            setLeaving(null);
            setLeavingError(null);
          }}
        />
      )}

      {leaving && problem && !isLocalPad(problem) && (
        <AttemptDialog
          taskId={problem.task_id}
          solved={attemptState?.solved ?? tests?.all_passed ?? false}
          pending={leavingPending}
          exiting={leavingPhase === "exit"}
          error={leavingError}
          onChoose={(save) => void resolveLeave(save)}
          onCancel={() => {
            if (leavingPending || leavingPhase === "exit") return;
            setLeaving(null);
            setLeavingError(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The mobile page turner: Prev / label / Next plus dots, over the canvas.
 *
 * It moves the *viewport*, not the scene — the board geography is identical to
 * desktop, so `board.json`, healing, and capture keep working unchanged.
 */
function RegionPager({
  active,
  onPick,
  disabled,
}: {
  active: RegionId;
  onPick: (region: RegionId) => void;
  disabled: boolean;
}) {
  const index = Math.max(0, MOBILE_REGION_ORDER.indexOf(active));
  const previous = MOBILE_REGION_ORDER[index - 1];
  const next = MOBILE_REGION_ORDER[index + 1];
  return (
    <nav className="lc-pager" aria-label="Board pages">
      <button
        type="button"
        className="lc-pager-step"
        aria-label={previous ? `Previous page: ${REGIONS[previous].label}` : "Previous page"}
        disabled={disabled || !previous}
        onClick={() => previous && onPick(previous)}
      >
        ‹
      </button>
      <div className="lc-pager-body">
        <span className="lc-pager-label">{REGIONS[active].label}</span>
        <span className="lc-pager-blurb">{REGION_BLURB[active]}</span>
        <div className="lc-pager-dots" role="tablist" aria-label="Board pages">
          {MOBILE_REGION_ORDER.map((region) => (
            <button
              key={region}
              type="button"
              role="tab"
              className={region === active ? "lc-pager-dot lc-pager-dot-active" : "lc-pager-dot"}
              aria-selected={region === active}
              aria-label={REGIONS[region].label}
              title={REGIONS[region].label}
              disabled={disabled}
              onClick={() => onPick(region)}
            />
          ))}
        </div>
      </div>
      <button
        type="button"
        className="lc-pager-step"
        aria-label={next ? `Next page: ${REGIONS[next].label}` : "Next page"}
        disabled={disabled || !next}
        onClick={() => next && onPick(next)}
      >
        ›
      </button>
    </nav>
  );
}


function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * Wait until AnnotateDocument has reported a stable height.
 * Used under the existing loading overlay so refresh runs on a finished page.
 *
 * Returns false when the timeout fires without a height — callers must not
 * treat that as "document ready" or the board reveals on a stuck "Opening…".
 *
 * A height of *zero* is an answer, not silence: an empty note has laid out and
 * is zero tall. Only the reporters that can legitimately be empty send it (see
 * AnnotateDocument), and the stability check still applies, so a reader that
 * reads zero on its way up does not resolve early.
 */
function waitForAnnotateLaidOut(
  readHeight: () => number | null,
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    let last: number | null = null;
    let stable = 0;
    const tick = () => {
      const height = readHeight();
      if (height != null && height >= 0) {
        if (last != null && Math.abs(height - last) < 1) {
          stable += 1;
          if (stable >= 3) {
            resolve(true);
            return;
          }
        } else {
          stable = 0;
        }
        last = height;
      }
      if (performance.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

/** Leave dialog fade duration (ms). Reduced-motion callers pass 0 at use sites. */
const LEAVE_DIALOG_FADE_MS = 180;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function slideDurationMs(): number {
  return prefersReducedMotion() ? 0 : 320;
}

function doneHoldMs(): number {
  return prefersReducedMotion() ? 0 : 560;
}

function boardFadeMs(): number {
  return prefersReducedMotion() ? 0 : 420;
}


/**
 * The reader cancelled the "which set of annotations?" question.
 *
 * Thrown rather than returned so the open unwinds through the same path a
 * failure does — the loading chrome, the suspended saves and the generation
 * guard all get reset by code that already exists. Caught by name at the
 * bottom of `loadAnnotate`, where it clears the chrome without an error
 * message: declining to open something is not a fault.
 */
class AnnotateOpenCancelled extends Error {
  constructor() {
    super("annotate-open-cancelled");
    this.name = "AnnotateOpenCancelled";
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function coachFailureTurns(
  failText: string | null,
): Array<{ content: string }> | null {
  return failText ? [{ content: failText }] : null;
}

/**
 * How long the board export gets before the send goes on without it.
 *
 * The pictures are worth waiting a few seconds for and never worth waiting
 * forever for — this runs *before* the turn is on screen, so a stall here is a
 * composer that appears to have swallowed the message.
 */
const THUMB_EXPORT_TIMEOUT_MS = 15_000;

/** Reject with `label` if `work` has not settled in time. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), ms);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        window.clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/**
 * Did the socket run fail for a reason HTTP would not share?
 *
 * A daemon older than run frames answers with a parse error; a dropped
 * connection reports itself. Both are worth retrying over HTTP. A model that
 * timed out, or a board the daemon refused, are not — those would fail the
 * same way twice and the second attempt only doubles the wait.
 */
function isSocketRunUnavailable(cause: unknown): boolean {
  const message = messageOf(cause).toLowerCase();
  return (
    message.includes("cannot parse frame") ||
    message.includes("unknown variant") ||
    message.includes("no run frames") ||
    message.includes("connection closed") ||
    message.includes("connection failed") ||
    message.includes("could not reach the coach") ||
    message.includes("could not reach the agent")
  );
}

/**
 * Rebuild a stored coach thread.
 *
 * The daemon stores the transcript opaquely, so anything malformed is dropped
 * here rather than crashing the panel on a half-written file.
 */
function restoreAgentMessages(stored: unknown[]): AgentChatMessage[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const message = entry as Partial<AgentChatMessage> & { drawing?: unknown };
    if (typeof message.id !== "string" || typeof message.role !== "string") return [];
    // Older builds could persist an in-flight placeholder. Drop it — a turn
    // stuck on "Working…" would wait for a socket that will never answer.
    if (message.pending) return [];
    const drawing = restoreMessageDrawing(message.drawing);
    const content = typeof message.content === "string" ? message.content : "";
    const processEvents = Array.isArray(message.processEvents)
      ? message.processEvents
      : undefined;
    const flags = Array.isArray(message.flags)
      ? message.flags.filter((flag): flag is string => typeof flag === "string" && flag.length > 0)
      : undefined;
    // This function rebuilds a turn field by field, so anything not named here
    // is dropped on reload — a reply thread has to be carried explicitly or it
    // survives exactly until the page refreshes.
    const raw = message.replyTo;
    const replyTo =
      raw &&
      typeof raw.id === "string" &&
      typeof raw.role === "string" &&
      typeof raw.excerpt === "string"
        ? { id: raw.id, role: raw.role as AgentChatMessage["role"], excerpt: raw.excerpt }
        : undefined;
    // Empty assistant shells left after stripping `pending` are noise.
    if (
      message.role === "assistant" &&
      !content.trim() &&
      !message.review &&
      !message.bridge &&
      !message.attachments?.length &&
      !drawing &&
      !processEvents?.length
    ) {
      return [];
    }
    return [
      {
        id: message.id,
        role: message.role as AgentChatMessage["role"],
        content,
        at: typeof message.at === "number" ? message.at : Date.now(),
        review: message.review,
        bridge: message.bridge,
        attachments: message.attachments,
        ...(flags && flags.length > 0 ? { flags } : {}),
        ...(processEvents ? { processEvents } : {}),
        ...(drawing ? { drawing } : {}),
        ...(replyTo ? { replyTo } : {}),
      },
    ];
  });
}

/** Persist finished turns only — never an in-flight `pending` placeholder. */
/**
 * The thread as it should be stored, which is not the thread as it is shown.
 *
 * Pending turns go, because a turn that never finished is not a turn. And an
 * attached photo drops to its thumbnail: `png` is sized for a vision model —
 * 1568px, 3–5.5 MB base64 — and it has already been sent by the time anything
 * persists. Keeping it would mean four photos on one message costing more than
 * the entire localStorage budget, forever, to redisplay an image the bubble
 * draws at 320px anyway.
 */
function persistableAgentMessages(messages: AgentChatMessage[]): AgentChatMessage[] {
  return messages
    .filter((message) => !message.pending)
    .map((message) => {
      if (!message.attachments?.some((att) => att.thumb)) return message;
      return {
        ...message,
        attachments: message.attachments.map((att) =>
          att.thumb ? { ...att, png: att.thumb } : att,
        ),
      };
    });
}

/**
 * Did the daemon refuse the request because the body was too big?
 *
 * Axum's own rejection is a plain-text 413 ("Failed to buffer the request body:
 * length limit exceeded"), and a reverse proxy in front of it may phrase it
 * differently, so match the status first and the wording second.
 */
function isBodyLimitError(cause: unknown): boolean {
  if (cause instanceof LcApiError && cause.status === 413) return true;
  const message = messageOf(cause).toLowerCase();
  return (
    message.includes("length limit") ||
    message.includes("payload too large") ||
    message.includes("body too large") ||
    message.includes("request entity too large")
  );
}

/** Local VLMs often hang on a board PNG until the 180s client timeout fires. */
function isLlmTimeoutError(cause: unknown): boolean {
  const message = messageOf(cause).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("operation timed out")
  );
}

/** Shared spinner → checkmark used by browse pick and ‹ › problem switch. */
function WorkspaceLoadStatus({ done, themeId }: { done: boolean; themeId: string }) {
  return (
    <div
      className="lc-overlay-spinner"
      role="status"
      aria-live="polite"
      aria-label={done ? "Workspace ready" : "Loading workspace"}
    >
      {!done && <LoadingDoodle themeId={themeId} />}
      {done ? (
        <div className="lc-spinner-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
      ) : (
        <div className="lc-spinner" aria-hidden="true" />
      )}
    </div>
  );
}

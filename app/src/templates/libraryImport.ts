/**
 * Import Excalidraw library files (`.excalidrawlib`) for the stamp palette.
 *
 * libraries.excalidraw.com is unreachable on a LAN-only tablet, so users can
 * download libraries on a machine with internet and import the file here.
 */

export interface ImportedLibraryItem {
  id: string;
  name: string;
  /** Elements with positions normalized so the top-left sits at (0, 0). */
  elements: ImportedElement[];
}

export interface ImportedElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  groupIds?: string[];
  [key: string]: unknown;
}

const STORAGE_KEY = "lc-imported-shape-library";

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeElements(raw: unknown[]): ImportedElement[] {
  const cloned = raw
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({ ...item }) as ImportedElement);

  if (cloned.length === 0) return [];

  let minX = Infinity;
  let minY = Infinity;
  for (const element of cloned) {
    if (typeof element.x === "number") minX = Math.min(minX, element.x);
    if (typeof element.y === "number") minY = Math.min(minY, element.y);
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;

  const idMap = new Map<string, string>();
  const groupIdMap = new Map<string, string>();
  for (const element of cloned) {
    const next = newId(String(element.type || "el"));
    if (typeof element.id === "string") idMap.set(element.id, next);
    element.id = next;
  }

  return cloned.map((element) => {
    const groupIds = Array.isArray(element.groupIds)
      ? element.groupIds.map((gid) => {
          if (typeof gid !== "string") return String(gid);
          if (!groupIdMap.has(gid)) groupIdMap.set(gid, newId("g"));
          return groupIdMap.get(gid)!;
        })
      : undefined;
    const containerId =
      typeof element.containerId === "string"
        ? idMap.get(element.containerId) ?? element.containerId
        : element.containerId;
    const boundElements = Array.isArray(element.boundElements)
      ? element.boundElements.map((binding) => {
          const record = asRecord(binding);
          if (!record || typeof record.id !== "string") return binding;
          return { ...record, id: idMap.get(record.id) ?? record.id };
        })
      : element.boundElements;

    return {
      ...element,
      x: (typeof element.x === "number" ? element.x : 0) - minX,
      y: (typeof element.y === "number" ? element.y : 0) - minY,
      groupIds,
      containerId,
      boundElements,
    };
  });
}

function itemName(item: Record<string, unknown>, index: number): string {
  if (typeof item.name === "string" && item.name.trim()) return item.name.trim();
  const elements = Array.isArray(item.elements) ? item.elements : [];
  for (const element of elements) {
    const record = asRecord(element);
    if (!record) continue;
    if (typeof record.text === "string" && record.text.trim()) return record.text.trim().slice(0, 40);
    const label = asRecord(record.label);
    if (label && typeof label.text === "string" && label.text.trim()) {
      return label.text.trim().slice(0, 40);
    }
  }
  return `Import ${index + 1}`;
}

/** Parse a `.excalidrawlib` JSON payload into placeable stamp items. */
export function parseExcalidrawLibrary(raw: string): ImportedLibraryItem[] {
  const parsed = JSON.parse(raw) as unknown;
  const root = asRecord(parsed);
  if (!root) throw new Error("library file is not a JSON object");

  const items = Array.isArray(root.libraryItems)
    ? root.libraryItems
    : Array.isArray(root.library)
      ? root.library
      : null;
  if (!items) throw new Error("no libraryItems found in file");

  const out: ImportedLibraryItem[] = [];
  items.forEach((entry, index) => {
    const item = asRecord(entry);
    if (!item) return;
    const elements = Array.isArray(item.elements) ? item.elements : null;
    if (!elements || elements.length === 0) return;
    out.push({
      id: typeof item.id === "string" ? `import-${item.id}` : newId("import"),
      name: itemName(item, index),
      elements: normalizeElements(elements),
    });
  });

  if (out.length === 0) throw new Error("library contained no drawable items");
  return out;
}

export function loadImportedLibrary(): ImportedLibraryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ImportedLibraryItem[]) : [];
  } catch {
    return [];
  }
}

export function saveImportedLibrary(items: ImportedLibraryItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

/** Shift normalized library elements to a drop point. Always unlocked so the
 * student can drag them — library files often ship with `locked: true`. */
export function placeImportedElements(
  elements: ImportedElement[],
  x: number,
  y: number,
  groupTogether: boolean,
): ImportedElement[] {
  const groupId = groupTogether && elements.length > 1 ? newId("lcstamp") : null;
  return elements.map((element) => {
    const nextGroups = groupTogether
      ? [...(Array.isArray(element.groupIds) ? element.groupIds : [])]
      : [];
    if (groupId) nextGroups.push(groupId);
    return {
      ...element,
      id: newId(String(element.type || "el")),
      x: (typeof element.x === "number" ? element.x : 0) + x,
      y: (typeof element.y === "number" ? element.y : 0) + y,
      // Imports from .excalidrawlib frequently mark every piece locked.
      locked: false,
      groupIds: nextGroups.length > 0 ? nextGroups : undefined,
      customData: {
        ...(asRecord(element.customData) ?? {}),
        lcStamp: true,
        ...(groupId ? { lcStampGroup: groupId } : {}),
      },
    };
  });
}

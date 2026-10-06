export type PadKind = "annotate" | "whiteboard" | "problem";
export interface BookIdentity { kind: PadKind; id: string }
export interface BookMeta extends BookIdentity { [field: string]: unknown }
export interface SyncState extends BookIdentity {
  changeSeq: number;
  syncedChangeSeq: number;
  recordRev: number;
  baseRecordWireHash: string | null;
  baseRecordLocalHash: string | null;
  appliedBookRev: number;
  observedBookRev: number;
  bootstrap: boolean;
  lifecycle: null | {
    action: "delete" | "restore";
    seq: number;
    token: string;
    baseBookRev: number | null;
    goneSeq: number | null;
  };
  lastAttempt: null | {
    uploadId: string;
    requestHash: string;
    record: null | { capturedSeq: number; wireHash: string; localHash: string };
    pages: Array<{ key: string; pageId: number; capturedSeq: number; wireHash: string; localHash: string }>;
    lifecycleToken: string | null;
  };
}

export const syncStateKey = (kind: PadKind, id: string): string => `${kind}:${id}`;
export const bookMetaKey = syncStateKey;

export function seedSyncState(kind: PadKind, id: string): SyncState {
  return { kind, id, changeSeq: 1, syncedChangeSeq: 0, recordRev: 0,
    baseRecordWireHash: null, baseRecordLocalHash: null, appliedBookRev: 0,
    observedBookRev: 0, bootstrap: true, lifecycle: null, lastAttempt: null };
}

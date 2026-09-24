export function LibraryTimes({updatedAt,lastSyncedAt,hubAckUpdatedAt}:{updatedAt:number;lastSyncedAt?:number;hubAckUpdatedAt?:number}) {
  return <span className="lc-library-times">
    <span>Last edit <time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleString()}</time></span>
    <span>Last sync {lastSyncedAt ? <time dateTime={new Date(lastSyncedAt).toISOString()}>{new Date(lastSyncedAt).toLocaleString()}</time> : hubAckUpdatedAt ? "Time not recorded" : "Not synced"}</span>
  </span>;
}

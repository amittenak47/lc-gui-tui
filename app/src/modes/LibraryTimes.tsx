export function LibraryTimes({updatedAt,lastSyncedAt,hubAckUpdatedAt}:{updatedAt:number;lastSyncedAt?:number;hubAckUpdatedAt?:number}) {
  return <span className="lc-library-times">
    <span><span>Last edit</span><time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleString()}</time></span>
    <span><span>Last sync</span>{lastSyncedAt ? <time dateTime={new Date(lastSyncedAt).toISOString()}>{new Date(lastSyncedAt).toLocaleString()}</time> : <span>{hubAckUpdatedAt ? "Time not recorded" : "Not synced"}</span>}</span>
  </span>;
}

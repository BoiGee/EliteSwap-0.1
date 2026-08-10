import { useEffect, useState } from "react";
import { getSignedMediaUrl } from "@/lib/forum";
import { Clock } from "lucide-react";

interface MediaRow {
  id: string;
  kind: "image" | "audio";
  status: "pending" | "approved" | "rejected";
  owner_id?: string;
}

function MediaItem({ row, viewerCanSeePending }: { row: MediaRow; viewerCanSeePending: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const visible = row.status === "approved" || viewerCanSeePending;

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getSignedMediaUrl(row.id)
      .then((r) => { if (!cancelled) setUrl(r.url); })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, [row.id, visible]);

  if (!visible) {
    return (
      <div className="text-xs text-muted-foreground inline-flex items-center gap-1 rounded border border-dashed border-border px-2 py-1">
        <Clock className="w-3 h-3" />
        {row.kind === "image" ? "Image" : "Voice note"} awaiting review
      </div>
    );
  }

  if (err) return <div className="text-xs text-destructive">Failed to load media</div>;
  if (!url) return <div className="text-xs text-muted-foreground animate-pulse">Loading…</div>;

  if (row.kind === "image") {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt="" loading="lazy" className="max-w-xs rounded-md border border-border" />
      </a>
    );
  }
  return <audio controls src={url} className="max-w-xs" />;
}

export default function MediaGallery({
  items,
  viewerId,
  isAdmin,
}: { items: MediaRow[]; viewerId?: string | null; isAdmin?: boolean }) {
  if (!items?.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-3">
      {items.map((m) => (
        <MediaItem
          key={m.id}
          row={m}
          viewerCanSeePending={!!isAdmin || (!!viewerId && m.owner_id === viewerId)}
        />
      ))}
    </div>
  );
}

import { ShieldCheck } from "lucide-react";

export default function AuthorLabel({
  postedAsAdmin,
  name,
}: {
  postedAsAdmin?: boolean | null;
  name?: string | null;
}) {
  if (postedAsAdmin) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-primary">
        Admin <ShieldCheck className="w-3 h-3" aria-label="Verified admin" />
      </span>
    );
  }
  return <span>{name ?? "User"}</span>;
}

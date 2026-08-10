import { Helmet } from "react-helmet-async";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ForumLayout from "./ForumLayout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForumCategories, useCreateThread } from "@/hooks/useForum";
import Composer from "@/components/forum/Composer";
import { attachMediaToTarget } from "@/lib/forum";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

export default function NewThread() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: categories } = useForumCategories();
  const initialSlug = params.get("c") ?? "";
  const initialCat = categories?.find((c) => c.slug === initialSlug);
  const [categoryId, setCategoryId] = useState<string>(initialCat?.id ?? "");
  const [title, setTitle] = useState("");
  const createThread = useCreateThread();

  if (!user) {
    navigate("/auth");
    return null;
  }

  return (
    <ForumLayout>
      <Helmet><title>New thread — Forum</title></Helmet>
      <div className="max-w-2xl mx-auto space-y-4">
        <h1 className="text-2xl font-heading font-bold">Start a new thread</h1>
        <div className="space-y-1">
          <Label>Category</Label>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm"
          >
            <option value="">Choose…</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What is your post about?" />
        </div>
        <Composer
          submitLabel="Post thread"
          placeholder="Share details, context, or steps…"
          onSubmit={async ({ body_md, mediaIds }) => {
            if (!categoryId) { toast.error("Pick a category"); return; }
            if (title.trim().length < 3) { toast.error("Title is too short"); return; }
            const thread = await createThread.mutateAsync({ category_id: categoryId, title, body_md });
            if (mediaIds.length) await attachMediaToTarget(mediaIds, { thread_id: thread.id });
            toast.success("Thread posted");
            navigate(`/forum/t/${thread.id}`);
          }}
        />
      </div>
    </ForumLayout>
  );
}

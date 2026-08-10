import { supabase } from "@/integrations/supabase/client";
import { generateClientId } from "@/lib/utils";

export const FORUM_BUCKET = "forum-media";

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
export const AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const AUDIO_MAX_DURATION_MS = 120_000;
export const AUDIO_MIMES = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/mp3", "audio/ogg"];

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "thread";
}

export type ForumMediaKind = "image" | "audio";
export type ForumMediaStatus = "pending" | "approved" | "rejected";

export interface UploadedMedia {
  id: string;
  kind: ForumMediaKind;
  status: ForumMediaStatus;
  storage_path: string;
}

/**
 * Upload a file to the private forum-media bucket and create a forum_media row (pending).
 * Path layout: {owner_id}/{uuid}-{name}
 */
export async function uploadForumMedia(
  file: File | Blob,
  kind: ForumMediaKind,
  opts: { thread_id?: string; reply_id?: string; duration_ms?: number; width?: number; height?: number } = {},
): Promise<UploadedMedia> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  if (kind === "image") {
    if (file.size > IMAGE_MAX_BYTES) throw new Error("Image larger than 5MB");
    if (!IMAGE_MIMES.includes(file.type)) throw new Error("Image must be JPEG, PNG, or WEBP");
  } else {
    if (file.size > AUDIO_MAX_BYTES) throw new Error("Voice note larger than 8MB");
    if (opts.duration_ms && opts.duration_ms > AUDIO_MAX_DURATION_MS) {
      throw new Error("Voice note longer than 2 minutes");
    }
  }

  const ext =
    file.type.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ||
    (kind === "image" ? "jpg" : "webm");
  const path = `${user.id}/${generateClientId("upload")}.${ext}`;

  const { error: upErr } = await supabase.storage.from(FORUM_BUCKET).upload(path, file, {
    contentType: file.type || (kind === "image" ? "image/jpeg" : "audio/webm"),
    upsert: false,
  });
  if (upErr) throw upErr;

  const { data, error } = await supabase
    .from("forum_media")
    .insert({
      owner_id: user.id,
      thread_id: opts.thread_id ?? null,
      reply_id: opts.reply_id ?? null,
      kind,
      storage_path: path,
      mime: file.type || (kind === "image" ? "image/jpeg" : "audio/webm"),
      bytes: file.size,
      duration_ms: opts.duration_ms ?? null,
      width: opts.width ?? null,
      height: opts.height ?? null,
      status: "pending",
    })
    .select("id, kind, status, storage_path")
    .single();
  if (error) {
    // best-effort cleanup
    await supabase.storage.from(FORUM_BUCKET).remove([path]).catch(() => {});
    throw error;
  }
  return data as UploadedMedia;
}

export async function attachMediaToTarget(
  mediaIds: string[],
  target: { thread_id?: string; reply_id?: string },
): Promise<void> {
  if (!mediaIds.length) return;
  const { error } = await supabase
    .from("forum_media")
    .update({
      thread_id: target.thread_id ?? null,
      reply_id: target.reply_id ?? null,
    })
    .in("id", mediaIds);
  if (error) throw error;
}

export async function getSignedMediaUrl(media_id: string): Promise<{ url: string; kind: ForumMediaKind; mime: string }> {
  const { data, error } = await supabase.functions.invoke("forum-media-url", {
    body: { media_id },
  });
  if (error) throw error;
  return data as { url: string; kind: ForumMediaKind; mime: string };
}

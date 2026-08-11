import { useState, useEffect, useRef, useCallback } from "react";
import { MessageCircle, X, Send, Paperclip, File, Image, Music, Video, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  useSupportChatNotifications,
  markConversationRead,
  requestNotificationPermissionOnce,
  hasAskedNotificationPermission,
} from "@/hooks/useSupportChatNotifications";

interface Message {
  id: string;
  content: string | null;
  file_url: string | null;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  is_admin: boolean;
  created_at: string;
  sender_id: string;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function FileIcon({ type }: { type: string | null }) {
  if (!type) return <File className="w-4 h-4" />;
  if (type.startsWith("image/")) return <Image className="w-4 h-4" />;
  if (type.startsWith("audio/")) return <Music className="w-4 h-4" />;
  if (type.startsWith("video/")) return <Video className="w-4 h-4" />;
  return <File className="w-4 h-4" />;
}

export default function SupportChat() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showPermPrompt, setShowPermPrompt] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { unreadByConv } = useSupportChatNotifications();
  const totalUnread = Object.values(unreadByConv).reduce((a, b) => a + b, 0);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, 50);
  }, []);

  // Load or create conversation
  useEffect(() => {
    if (!user || !open) return;

    const findOpenConversation = () =>
      supabase
        .from("support_conversations")
        .select("id")
        // "pending" is still an active thread (admin flagged it, not resolved) —
        // only "closed" should start a fresh conversation on reopen.
        .in("status", ["open", "pending"])
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    const loadConversation = async () => {
      const { data } = await findOpenConversation();

      if (data) {
        setConversationId(data.id);
        return;
      }

      const { data: newConv, error } = await supabase
        .from("support_conversations")
        .insert({ user_id: user.id })
        .select("id")
        .single();

      if (newConv) {
        setConversationId(newConv.id);
        return;
      }

      // Lost a create race against another tab/device (a unique constraint
      // guarantees only one "open" conversation per user) — fall back to
      // whichever one now exists instead of leaving the widget stuck with
      // no conversation at all.
      if (error) {
        const { data: existing } = await findOpenConversation();
        if (existing) setConversationId(existing.id);
      }
    };

    loadConversation();
  }, [user, open]);

  // Load messages
  useEffect(() => {
    if (!conversationId) return;

    const loadMessages = async () => {
      const { data } = await supabase
        .from("support_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      if (data) {
        setMessages(data as Message[]);
        scrollToBottom();
      }
    };

    loadMessages();

    // Realtime subscription
    const channel = supabase
      .channel(`chat-${conversationId}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "support_messages",
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => {
        setMessages((prev) => [...prev, payload.new as Message]);
        scrollToBottom();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [conversationId, scrollToBottom]);

  const sendMessage = async (content?: string, fileData?: { url: string; name: string; type: string; size: number }) => {
    if (!conversationId || !user) return;
    if (!content && !fileData) return;

    setSending(true);
    const { data: inserted, error } = await supabase.from("support_messages").insert({
      conversation_id: conversationId,
      sender_id: user.id,
      content: content || null,
      is_admin: false,
      file_url: fileData?.url || null,
      file_name: fileData?.name || null,
      file_type: fileData?.type || null,
      file_size: fileData?.size || null,
    }).select("id").maybeSingle();

    if (error) {
      toast({ title: "Failed to send", description: "Please try again.", variant: "destructive" });
    } else if (inserted?.id) {
      // Fire-and-forget admin push notification.
      supabase.functions.invoke("notify-admin-event", {
        body: { event: "support_message", messageId: inserted.id },
      }).catch(() => {});
    }
    setSending(false);
  };

  const handleSend = () => {
    if (!input.trim()) return;
    sendMessage(input.trim());
    setInput("");
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      toast({ title: "File too large", description: "Max file size is 5MB.", variant: "destructive" });
      return;
    }

    const ext = file.name.split(".").pop() || "bin";
    const path = `${user!.id}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("chat-attachments").upload(path, file);

    if (error) {
      toast({ title: "Upload failed", description: "Please try again.", variant: "destructive" });
      return;
    }

    const { data: urlData, error: signErr } = await supabase.storage
      .from("chat-attachments")
      .createSignedUrl(path, 60 * 60 * 24 * 365);
    if (signErr || !urlData?.signedUrl) {
      toast({ title: "Upload failed", description: "Could not generate file link.", variant: "destructive" });
      return;
    }
    await sendMessage(undefined, {
      url: urlData.signedUrl,
      name: file.name,
      type: file.type,
      size: file.size,
    });

    if (fileRef.current) fileRef.current.value = "";
  };

  // Mark conversation as read whenever the panel is open & a message is in view
  useEffect(() => {
    if (open && conversationId) {
      markConversationRead(conversationId);
    }
  }, [open, conversationId, messages.length]);

  // Show one-time desktop-permission prompt when chat is opened
  useEffect(() => {
    if (!open) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default" && !hasAskedNotificationPermission()) {
      setShowPermPrompt(true);
    }
  }, [open]);

  if (!user) return null;

  return (
    <>
      {/* Chat bubble */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:scale-105 transition-transform flex items-center justify-center neon-glow"
          aria-label={totalUnread > 0 ? `Open support chat (${totalUnread} new)` : "Open support chat"}
        >
          <MessageCircle className="w-6 h-6" />
          {totalUnread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center border-2 border-background">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-[360px] h-[500px] flex flex-col glass neon-border rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/80">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-primary" />
              <span className="font-heading font-semibold text-sm">Support Chat</span>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close support chat" className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>

          </div>

          {/* Notification permission prompt */}
          {showPermPrompt && (
            <div className="px-3 py-2 bg-primary/10 border-b border-primary/30 flex items-center gap-2 text-[11px]">
              <Bell className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="flex-1 font-heading">Allow desktop alerts for new messages?</span>
              <button
                onClick={async () => {
                  await requestNotificationPermissionOnce();
                  setShowPermPrompt(false);
                }}
                className="text-primary font-heading font-semibold hover:underline"
              >
                Allow
              </button>
              <button
                onClick={() => setShowPermPrompt(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Dismiss"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground text-xs mt-8">
                <p className="font-heading">Welcome to support! 👋</p>
                <p className="mt-1">Send a message and we'll get back to you.</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.is_admin ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[80%] rounded-xl px-3 py-2 text-xs ${
                  m.is_admin
                    ? "bg-muted text-foreground"
                    : "bg-primary text-primary-foreground"
                }`}>
                  {m.is_admin && <div className="text-[10px] font-heading font-semibold mb-0.5 opacity-70">Admin</div>}
                  {m.content && <p className="break-words">{m.content}</p>}
                  {m.file_url && (
                    <a href={m.file_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 mt-1 underline opacity-80 hover:opacity-100">
                      <FileIcon type={m.file_type} />
                      <span className="truncate max-w-[140px]">{m.file_name}</span>
                      {m.file_size && <span className="text-[10px]">({formatFileSize(m.file_size)})</span>}
                    </a>
                  )}
                  {m.file_url && m.file_type?.startsWith("image/") && (
                    <img src={m.file_url} alt={m.file_name ? `Attachment: ${m.file_name}` : "Chat image attachment"} className="mt-1.5 rounded-md max-h-32 object-cover" />
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="border-t border-border px-3 py-2 flex items-center gap-2 bg-background/80">
            <input type="file" ref={fileRef} onChange={handleFile} className="hidden" accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.zip" />
            <button onClick={() => fileRef.current?.click()} aria-label="Attach file" className="text-muted-foreground hover:text-primary transition-colors" disabled={sending}>
              <Paperclip className="w-4 h-4" />
            </button>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder="Type a message..."
              className="flex-1 h-8 text-xs border-0 bg-muted/30 focus-visible:ring-1"
              disabled={sending}
            />
            <button onClick={handleSend} disabled={sending || !input.trim()} aria-label="Send message" className="text-primary hover:text-primary/80 disabled:opacity-40">
              <Send className="w-4 h-4" />
            </button>
          </div>

        </div>
      )}
    </>
  );
}

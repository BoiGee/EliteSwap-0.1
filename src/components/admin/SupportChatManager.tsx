import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Send,
  Paperclip,
  File,
  Image as ImageIcon,
  Music,
  Video,
  User,
  Search,
  StickyNote,
  Zap,
  CheckCircle2,
  Clock,
  Circle,
  MessageSquare,
  X,
  Plus,
  Trash2,
  Flag,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import {
  useSupportChatNotifications,
  markConversationRead,
} from "@/hooks/useSupportChatNotifications";
import { cn } from "@/lib/utils";

interface Conversation {
  id: string;
  user_id: string;
  subject: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  conversation_id: string;
  content: string | null;
  file_url: string | null;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  is_admin: boolean;
  created_at: string;
  sender_id: string;
}

interface InternalNote {
  id: string;
  conversation_id: string;
  author_id: string;
  content: string;
  created_at: string;
}

interface CannedResponse {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
}

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
type StatusFilter = "all" | "open" | "pending" | "closed" | "unread";

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function FileIcon({ type }: { type: string | null }) {
  if (!type) return <File className="w-4 h-4" />;
  if (type.startsWith("image/")) return <ImageIcon className="w-4 h-4" />;
  if (type.startsWith("audio/")) return <Music className="w-4 h-4" />;
  if (type.startsWith("video/")) return <Video className="w-4 h-4" />;
  return <File className="w-4 h-4" />;
}

function statusMeta(status: string) {
  switch (status) {
    case "open":
      return { label: "Open", color: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30", Icon: Circle };
    case "pending":
      return { label: "Pending", color: "bg-amber-500/15 text-amber-500 border-amber-500/30", Icon: Clock };
    case "closed":
      return { label: "Closed", color: "bg-muted text-muted-foreground border-border", Icon: CheckCircle2 };
    default:
      return { label: status, color: "bg-muted text-muted-foreground border-border", Icon: Circle };
  }
}

function priorityMeta(priority: string) {
  switch (priority) {
    case "urgent":
      return "text-destructive";
    case "high":
      return "text-amber-500";
    default:
      return "text-muted-foreground";
  }
}

function relativeTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString();
}

export default function SupportChatManager({ profiles }: { profiles: Profile[] }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [lastMessageMap, setLastMessageMap] = useState<Record<string, { content: string; created_at: string; is_admin: boolean }>>({});
  const [selectedConv, setSelectedConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [notesOpen, setNotesOpen] = useState(false);
  const [cannedMgrOpen, setCannedMgrOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { unreadByConv } = useSupportChatNotifications();

  const profileFor = useCallback(
    (userId: string) => profiles.find((p) => p.user_id === userId),
    [profiles],
  );

  const labelForUser = useCallback(
    (userId: string) => {
      const p = profileFor(userId);
      return p?.display_name || p?.email || userId.slice(0, 8);
    },
    [profileFor],
  );

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, 50);
  }, []);

  // Load conversations + last message previews
  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from("support_conversations")
      .select("*")
      .order("updated_at", { ascending: false });
    if (data) setConversations(data as Conversation[]);

    const { data: recent } = await supabase
      .from("support_messages")
      .select("conversation_id, content, file_url, created_at, is_admin")
      .order("created_at", { ascending: false })
      .limit(500);
    if (recent) {
      const map: Record<string, { content: string; created_at: string; is_admin: boolean }> = {};
      for (const m of recent as Array<{ conversation_id: string; content: string | null; file_url: string | null; created_at: string; is_admin: boolean }>) {
        if (!map[m.conversation_id]) {
          map[m.conversation_id] = {
            content: m.content ?? (m.file_url ? "📎 Attachment" : ""),
            created_at: m.created_at,
            is_admin: m.is_admin,
          };
        }
      }
      setLastMessageMap(map);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Realtime: conversation table updates (status changes, new convs)
  useEffect(() => {
    const ch = supabase
      .channel("admin-conv-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "support_conversations" }, () => {
        loadConversations();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "support_messages" }, (payload) => {
        const m = payload.new as Message;
        setLastMessageMap((prev) => ({
          ...prev,
          [m.conversation_id]: {
            content: m.content ?? (m.file_url ? "📎 Attachment" : ""),
            created_at: m.created_at,
            is_admin: m.is_admin,
          },
        }));
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === m.conversation_id);
          if (idx === -1) return prev;
          const updated = { ...prev[idx], updated_at: m.created_at };
          return [updated, ...prev.filter((c) => c.id !== m.conversation_id)];
        });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [loadConversations]);

  // Load canned responses
  const loadCanned = useCallback(async () => {
    const { data } = await supabase
      .from("support_canned_responses")
      .select("*")
      .order("title", { ascending: true });
    if (data) setCannedResponses(data as CannedResponse[]);
  }, []);

  useEffect(() => {
    loadCanned();
  }, [loadCanned]);

  // Load messages + notes for selected conversation
  useEffect(() => {
    if (!selectedConv) {
      setMessages([]);
      setNotes([]);
      return;
    }
    markConversationRead(selectedConv);

    const loadMsgs = async () => {
      const { data } = await supabase
        .from("support_messages")
        .select("*")
        .eq("conversation_id", selectedConv)
        .order("created_at", { ascending: true });
      if (data) {
        setMessages(data as Message[]);
        scrollToBottom();
      }
    };
    const loadNotes = async () => {
      const { data } = await supabase
        .from("support_internal_notes")
        .select("*")
        .eq("conversation_id", selectedConv)
        .order("created_at", { ascending: true });
      if (data) setNotes(data as InternalNote[]);
    };
    loadMsgs();
    loadNotes();

    const channel = supabase
      .channel(`admin-chat-${selectedConv}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "support_messages",
          filter: `conversation_id=eq.${selectedConv}`,
        },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message]);
          scrollToBottom();
          if (selectedConv) markConversationRead(selectedConv);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedConv, scrollToBottom]);

  const sendMessage = async (
    content?: string,
    fileData?: { url: string; name: string; type: string; size: number },
  ) => {
    if (!selectedConv || !user) return;
    if (!content && !fileData) return;

    setSending(true);
    const { error } = await supabase.from("support_messages").insert({
      conversation_id: selectedConv,
      sender_id: user.id,
      content: content || null,
      is_admin: true,
      file_url: fileData?.url || null,
      file_name: fileData?.name || null,
      file_type: fileData?.type || null,
      file_size: fileData?.size || null,
    });
    if (error) toast({ title: "Failed to send", variant: "destructive" });
    // Auto-bump status to open when admin replies to a pending conv
    const conv = conversations.find((c) => c.id === selectedConv);
    if (conv && conv.status === "pending") {
      await supabase.from("support_conversations").update({ status: "open" }).eq("id", selectedConv);
    }
    setSending(false);
    setTimeout(() => inputRef.current?.focus(), 30);
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
      toast({ title: "File too large", description: "Max 5MB", variant: "destructive" });
      return;
    }
    const ext = file.name.split(".").pop() || "bin";
    const path = `admin/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("chat-attachments").upload(path, file);
    if (error) {
      toast({ title: "Upload failed", variant: "destructive" });
      return;
    }
    const { data: urlData, error: signErr } = await supabase.storage
      .from("chat-attachments")
      .createSignedUrl(path, 60 * 60 * 24 * 365);
    if (signErr || !urlData?.signedUrl) {
      toast({ title: "Upload failed", variant: "destructive" });
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

  const updateConvField = async (field: "status" | "priority" | "assigned_to", value: string | null) => {
    if (!selectedConv) return;
    const patch: Record<string, string | null> = { [field]: value };
    const { error } = await supabase
      .from("support_conversations")
      .update(patch as never)
      .eq("id", selectedConv);
    if (error) {
      toast({ title: "Update failed", variant: "destructive" });
      return;
    }
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedConv ? { ...c, [field]: value } as Conversation : c)),
    );
  };

  const addNote = async () => {
    if (!newNote.trim() || !selectedConv || !user) return;
    const { data, error } = await supabase.from("support_internal_notes").insert({
      conversation_id: selectedConv,
      author_id: user.id,
      content: newNote.trim(),
    }).select().single();
    if (error) {
      toast({ title: "Note failed", variant: "destructive" });
      return;
    }
    if (data) setNotes((prev) => [...prev, data as InternalNote]);
    setNewNote("");
  };

  const deleteNote = async (id: string) => {
    await supabase.from("support_internal_notes").delete().eq("id", id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const insertCanned = (body: string) => {
    setInput((prev) => (prev ? prev + "\n" + body : body));
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  // Keyboard shortcuts: Cmd/Ctrl+Enter send
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (statusFilter === "unread") {
        if (!(unreadByConv[c.id] ?? 0)) return false;
      } else if (statusFilter !== "all") {
        if (c.status !== statusFilter) return false;
      }
      if (q) {
        const p = profileFor(c.user_id);
        const hay = `${p?.email ?? ""} ${p?.display_name ?? ""} ${c.subject ?? ""} ${lastMessageMap[c.id]?.content ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [conversations, statusFilter, search, unreadByConv, profileFor, lastMessageMap]);

  const counts = useMemo(() => {
    const c = { all: conversations.length, open: 0, pending: 0, closed: 0, unread: 0 };
    for (const conv of conversations) {
      if (conv.status === "open") c.open++;
      else if (conv.status === "pending") c.pending++;
      else if (conv.status === "closed") c.closed++;
      if (unreadByConv[conv.id]) c.unread++;
    }
    return c;
  }, [conversations, unreadByConv]);

  const activeConv = conversations.find((c) => c.id === selectedConv);
  const activeUserProfile = activeConv ? profileFor(activeConv.user_id) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-heading font-bold text-foreground">Support Inbox</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {counts.open} open · {counts.pending} pending · {counts.unread} unread
          </p>
        </div>
        <Dialog open={cannedMgrOpen} onOpenChange={setCannedMgrOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-2">
              <Zap className="w-3.5 h-3.5" /> Canned replies
            </Button>
          </DialogTrigger>
          <CannedManager
            cannedResponses={cannedResponses}
            onChanged={loadCanned}
            userId={user?.id}
          />
        </Dialog>
      </div>

      <div className="flex gap-4 h-[calc(100vh-260px)] min-h-[520px]">
        {/* Conversation list */}
        <div className="w-72 flex-shrink-0 glass rounded-xl overflow-hidden flex flex-col">
          <div className="p-3 border-b border-border space-y-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations..."
                className="h-8 pl-7 text-xs"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {(["all", "unread", "open", "pending", "closed"] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    "text-[10px] font-heading font-semibold px-2 py-0.5 rounded-full border transition-colors capitalize",
                    statusFilter === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {s} {counts[s] > 0 && <span className="opacity-70">({counts[s]})</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.map((c) => {
              const unread = unreadByConv[c.id] ?? 0;
              const last = lastMessageMap[c.id];
              const meta = statusMeta(c.status);
              const isSelected = selectedConv === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedConv(c.id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 border-b border-border/30 hover:bg-muted/40 transition-colors",
                    isSelected && "bg-primary/10 border-l-2 border-l-primary",
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                      <User className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("text-xs font-heading font-semibold truncate", unread > 0 && "text-foreground")}>
                          {labelForUser(c.user_id)}
                        </span>
                        {c.priority !== "normal" && (
                          <Flag className={cn("w-3 h-3 flex-shrink-0", priorityMeta(c.priority))} />
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {relativeTime(c.updated_at)}
                      </div>
                    </div>
                    {unread > 0 && (
                      <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                        {unread > 99 ? "99+" : unread}
                      </span>
                    )}
                  </div>
                  {last && (
                    <p className={cn("text-[11px] truncate pl-9", unread > 0 ? "text-foreground/80" : "text-muted-foreground")}>
                      {last.is_admin && <span className="opacity-60">You: </span>}
                      {last.content}
                    </p>
                  )}
                  <div className="pl-9 mt-1">
                    <span className={cn("inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border font-heading font-semibold", meta.color)}>
                      <meta.Icon className="w-2.5 h-2.5" />
                      {meta.label}
                    </span>
                  </div>
                </button>
              );
            })}
            {filteredConversations.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <MessageSquare className="w-8 h-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">No conversations match.</p>
              </div>
            )}
          </div>
        </div>

        {/* Message thread */}
        <div className="flex-1 glass rounded-xl overflow-hidden flex flex-col min-w-0">
          {!selectedConv || !activeConv ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
              <MessageSquare className="w-12 h-12 text-muted-foreground/40 mb-3" />
              <p className="text-sm font-heading font-semibold text-foreground">Select a conversation</p>
              <p className="text-xs text-muted-foreground mt-1">Pick a thread from the list to start replying.</p>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-wrap">
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center">
                  <User className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-heading font-semibold truncate">
                    {labelForUser(activeConv.user_id)}
                  </div>
                  {activeUserProfile?.email && activeUserProfile.display_name && (
                    <div className="text-[10px] text-muted-foreground truncate">{activeUserProfile.email}</div>
                  )}
                </div>
                <Select value={activeConv.status} onValueChange={(v) => updateConvField("status", v)}>
                  <SelectTrigger className="h-7 w-[110px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={activeConv.priority} onValueChange={(v) => updateConvField("priority", v)}>
                  <SelectTrigger className="h-7 w-[110px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant={notesOpen ? "default" : "outline"}
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setNotesOpen((v) => !v)}
                >
                  <StickyNote className="w-3.5 h-3.5" />
                  Notes {notes.length > 0 && `(${notes.length})`}
                </Button>
              </div>

              <div className="flex-1 flex min-h-0">
                {/* Messages */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-w-0">
                  {messages.map((m, i) => {
                    const prev = messages[i - 1];
                    const showDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
                    return (
                      <div key={m.id}>
                        {showDay && (
                          <div className="flex items-center gap-2 my-3">
                            <div className="flex-1 h-px bg-border" />
                            <span className="text-[10px] text-muted-foreground font-heading">
                              {new Date(m.created_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                            </span>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                        )}
                        <div className={`flex ${m.is_admin ? "justify-end" : "justify-start"}`}>
                          <div className={cn(
                            "max-w-[75%] rounded-2xl px-3.5 py-2 text-xs shadow-sm",
                            m.is_admin
                              ? "bg-primary text-primary-foreground rounded-br-sm"
                              : "bg-muted text-foreground rounded-bl-sm",
                          )}>
                            {m.content && <p className="break-words whitespace-pre-wrap leading-relaxed">{m.content}</p>}
                            {m.file_url && (
                              <a
                                href={m.file_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 mt-1 underline opacity-80 hover:opacity-100"
                              >
                                <FileIcon type={m.file_type} />
                                <span className="truncate max-w-[140px]">{m.file_name}</span>
                                {m.file_size && <span className="text-[10px]">({formatFileSize(m.file_size)})</span>}
                              </a>
                            )}
                            {m.file_url && m.file_type?.startsWith("image/") && (
                              <img src={m.file_url} alt={m.file_name || ""} className="mt-1.5 rounded-md max-h-40 object-cover" />
                            )}
                            <div className="text-[10px] opacity-50 mt-1">
                              {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {messages.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-8">No messages yet.</p>
                  )}
                </div>

                {/* Notes side panel */}
                {notesOpen && (
                  <div className="w-72 flex-shrink-0 border-l border-border bg-amber-500/5 flex flex-col">
                    <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-heading font-semibold text-foreground">
                        <StickyNote className="w-3.5 h-3.5 text-amber-500" /> Internal notes
                      </div>
                      <button onClick={() => setNotesOpen(false)} className="text-muted-foreground hover:text-foreground">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                      {notes.map((n) => (
                        <div key={n.id} className="group bg-amber-500/10 border border-amber-500/20 rounded-lg p-2 text-xs">
                          <p className="whitespace-pre-wrap break-words text-foreground">{n.content}</p>
                          <div className="flex items-center justify-between mt-1.5">
                            <span className="text-[10px] text-muted-foreground">
                              {labelForUser(n.author_id)} · {relativeTime(n.created_at)}
                            </span>
                            <button
                              onClick={() => deleteNote(n.id)}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                      {notes.length === 0 && (
                        <p className="text-[11px] text-muted-foreground text-center py-4">
                          Notes are admin-only. The user never sees these.
                        </p>
                      )}
                    </div>
                    <div className="border-t border-border p-2 space-y-1.5">
                      <Textarea
                        value={newNote}
                        onChange={(e) => setNewNote(e.target.value)}
                        placeholder="Add an internal note..."
                        className="text-xs min-h-[60px] resize-none"
                      />
                      <Button size="sm" onClick={addNote} disabled={!newNote.trim()} className="w-full h-7 text-xs">
                        <Plus className="w-3 h-3 mr-1" /> Add note
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="border-t border-border p-3 space-y-2">
                <div className="flex items-end gap-2">
                  <input
                    type="file"
                    ref={fileRef}
                    onChange={handleFile}
                    className="hidden"
                    accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.zip"
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="text-muted-foreground hover:text-primary mb-1.5"
                    disabled={sending}
                    title="Attach file"
                  >
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        className="text-muted-foreground hover:text-primary mb-1.5"
                        disabled={sending || cannedResponses.length === 0}
                        title="Insert canned reply"
                      >
                        <Zap className="w-4 h-4" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-72 p-1">
                      <div className="text-[10px] font-heading font-semibold text-muted-foreground px-2 py-1.5">
                        Canned replies
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {cannedResponses.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => insertCanned(c.body)}
                            className="w-full text-left px-2 py-2 rounded hover:bg-muted/50 transition"
                          >
                            <div className="text-xs font-heading font-semibold text-foreground">{c.title}</div>
                            <div className="text-[10px] text-muted-foreground truncate">{c.body}</div>
                          </button>
                        ))}
                        {cannedResponses.length === 0 && (
                          <p className="text-[11px] text-muted-foreground px-2 py-2">No saved replies yet.</p>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder="Type a reply... (Enter to send, Shift+Enter for newline)"
                    className="flex-1 min-h-[40px] max-h-[140px] text-xs resize-none"
                    disabled={sending}
                  />
                  <Button
                    size="sm"
                    onClick={handleSend}
                    disabled={sending || !input.trim()}
                    className="h-9 gap-1"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Send
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  ⌘/Ctrl+Enter or Enter to send · Shift+Enter for newline
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Canned response manager dialog ----
function CannedManager({
  cannedResponses,
  onChanged,
  userId,
}: {
  cannedResponses: CannedResponse[];
  onChanged: () => void;
  userId: string | undefined;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const create = async () => {
    if (!title.trim() || !body.trim()) return;
    const { error } = await supabase.from("support_canned_responses").insert({
      title: title.trim(),
      body: body.trim(),
      created_by: userId,
    });
    if (error) {
      toast({ title: "Failed to save", variant: "destructive" });
      return;
    }
    setTitle("");
    setBody("");
    onChanged();
  };

  const remove = async (id: string) => {
    await supabase.from("support_canned_responses").delete().eq("id", id);
    onChanged();
  };

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Canned replies</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
        {cannedResponses.map((c) => (
          <div key={c.id} className="group border border-border rounded-lg p-3 bg-muted/20">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-heading font-semibold">{c.title}</div>
                <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap break-words">{c.body}</p>
              </div>
              <button onClick={() => remove(c.id)} className="text-muted-foreground hover:text-destructive">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {cannedResponses.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No saved replies yet.</p>
        )}
      </div>
      <div className="border-t border-border pt-3 space-y-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (e.g. Refund policy)"
          className="h-8 text-xs"
        />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Reply body..."
          className="min-h-[80px] text-xs"
        />
      </div>
      <DialogFooter>
        <Button onClick={create} disabled={!title.trim() || !body.trim()} size="sm">
          <Plus className="w-3.5 h-3.5 mr-1" /> Save reply
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

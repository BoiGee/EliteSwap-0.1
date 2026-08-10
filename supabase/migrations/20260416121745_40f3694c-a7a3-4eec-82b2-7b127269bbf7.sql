
-- Support conversations table
CREATE TABLE public.support_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  subject TEXT DEFAULT 'Support Chat',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;

-- Users can view/create their own conversations
CREATE POLICY "Users can view own conversations" ON public.support_conversations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own conversations" ON public.support_conversations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can view all conversations" ON public.support_conversations
  FOR SELECT TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can update conversations" ON public.support_conversations
  FOR UPDATE TO authenticated USING (has_role('admin'));

-- Support messages table
CREATE TABLE public.support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  content TEXT,
  file_url TEXT,
  file_name TEXT,
  file_type TEXT,
  file_size INTEGER,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- Users can view messages in their conversations
CREATE POLICY "Users can view own messages" ON public.support_messages
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.support_conversations sc WHERE sc.id = conversation_id AND sc.user_id = auth.uid())
  );
CREATE POLICY "Users can insert own messages" ON public.support_messages
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.support_conversations sc WHERE sc.id = conversation_id AND sc.user_id = auth.uid())
    AND is_admin = false
  );
CREATE POLICY "Admins can view all messages" ON public.support_messages
  FOR SELECT TO authenticated USING (has_role('admin'));
CREATE POLICY "Admins can insert messages" ON public.support_messages
  FOR INSERT TO authenticated WITH CHECK (has_role('admin'));

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;

-- Trigger for updated_at on conversations
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.support_conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Storage bucket for chat attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES ('chat-attachments', 'chat-attachments', true, 5242880);

-- Storage policies
CREATE POLICY "Authenticated users can upload chat files" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'chat-attachments');
CREATE POLICY "Anyone can view chat files" ON storage.objects
  FOR SELECT USING (bucket_id = 'chat-attachments');

-- Vidu's realtime editing sessions need a SECOND connection beyond the
-- AliRTC media join: a control WebSocket (wss://api.vidu.com/live/ws/live/connect)
-- that must complete a conn_init handshake before Vidu actually starts
-- producing output. Confirmed by reading shengshu-ai/vidu-s-api's own
-- Node.js reference server (examples/node-quickstart/server.js) -- without
-- this handshake, a session just sits in "waiting" status forever: the
-- AliRTC media join still succeeds (so the local camera panel works fine),
-- but no transformed output ever gets published, which is exactly the
-- symptom live-tested this session.
--
-- That control WebSocket authenticates with the raw Vidu API key (same
-- trust requirement as the REST mint call), so it has to be opened
-- server-side by a new edge function (vidu-control-relay), using the SAME
-- pooled key the original mint-vidu-rtc-session call used -- Vidu scopes a
-- live_id to the account/key that created it, so a different randomly
-- re-picked pool key would likely be rejected. This column lets the
-- control-relay function look up which pool row to reuse.

ALTER TABLE public.studio_sessions
  ADD COLUMN IF NOT EXISTS vidu_pool_key_id uuid REFERENCES public.vidu_shared_pool(id);

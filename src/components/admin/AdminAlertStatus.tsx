// Small status pill + control shown in the admin dashboard header.
// Enables sound alerts, browser push, and iOS install guidance.
import { useEffect, useState } from "react";
import { Bell, BellOff, Volume2, Smartphone, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { useAdminAlerts } from "@/hooks/useAdminAlerts";
import { supabase } from "@/integrations/supabase/client";
import {
  pushSupported,
  subscribeAdminPush,
  unsubscribeAdminPush,
  isIos,
  isStandalone,
  isPreviewOrDev,
} from "@/lib/adminPush";

export default function AdminAlertStatus() {
  const { user } = useAuth();
  const { audioUnlocked } = useAdminAlerts(true);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported() || isPreviewOrDev()) return;
    navigator.serviceWorker.getRegistration("/").then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setSubscribed(!!sub);
    }).catch(() => {});
  }, []);

  const enablePush = async () => {
    if (!user?.id) return;
    setBusy(true);
    const res = await subscribeAdminPush(user.id);
    setBusy(false);
    setPermission(Notification.permission);
    if (res.ok) setSubscribed(true);
  };

  const disablePush = async () => {
    setBusy(true);
    await unsubscribeAdminPush();
    setSubscribed(false);
    setBusy(false);
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-admin-push-test");
      if (error) {
        toast.error(`Test failed: ${error.message}`);
      } else if (data?.skipped === "no_vapid") {
        toast.error("VAPID keys not configured on the server.");
      } else if (data?.skipped === "no_subs" || data?.sent === 0) {
        toast.warning("No devices received it. Make sure push is enabled on the device you want to test.");
      } else {
        toast.success(`Test sent to ${data?.sent ?? 0} device(s)`);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Test failed");
    } finally {
      setBusy(false);
    }
  };

  const iosNeedsInstall = isIos() && !isStandalone();
  const previewOrDev = isPreviewOrDev();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={audioUnlocked ? "default" : "secondary"} className="gap-1">
        <Volume2 className="h-3 w-3" />
        Sound {audioUnlocked ? "on" : "click page to enable"}
      </Badge>

      {previewOrDev ? (
        <Badge variant="secondary" className="gap-1">
          <BellOff className="h-3 w-3" /> Push unavailable in preview
        </Badge>
      ) : !pushSupported() ? (
        <Badge variant="secondary" className="gap-1">
          <BellOff className="h-3 w-3" /> Push not supported
        </Badge>
      ) : iosNeedsInstall ? (
        <Badge variant="secondary" className="gap-1">
          <Smartphone className="h-3 w-3" />
          Install to Home Screen to receive push (Share → Add to Home Screen)
        </Badge>
      ) : permission === "denied" ? (
        <Badge variant="destructive" className="gap-1">
          <BellOff className="h-3 w-3" /> Push blocked in browser settings
        </Badge>
      ) : subscribed ? (
        <>
          <Badge variant="default" className="gap-1">
            <Bell className="h-3 w-3" /> Push on
          </Badge>
          <Button size="sm" variant="outline" onClick={sendTest} disabled={busy} className="gap-1">
            <Send className="h-3 w-3" />
            {busy ? "Sending…" : "Send test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={disablePush} disabled={busy}>
            Disable
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={enablePush} disabled={busy} className="gap-1">
          <Bell className="h-3 w-3" />
          {busy ? "Enabling…" : "Enable push alerts"}
        </Button>
      )}
    </div>
  );
}

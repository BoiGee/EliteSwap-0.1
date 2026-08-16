import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getSafeErrorMessage } from "@/lib/errors";

export default function ProfileSection() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("profiles")
      .select("display_name, email")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDisplayName(data.display_name ?? "");
          setEmail(data.email ?? user.email ?? "");
        } else {
          setEmail(user.email ?? "");
        }
        setLoaded(true);
      });
  }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({ display_name: displayName || null })
      .eq("user_id", user.id);
    if (error) {
      console.error("[internal]", error);
      toast({ title: "Error", description: getSafeErrorMessage(error.code), variant: "destructive" });
    } else {
      toast({ title: "Profile updated ✅" });
    }
    setSaving(false);
  };

  if (!loaded) return null;

  return (
    <div className="glass border border-border rounded-2xl p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center text-primary font-heading font-bold text-lg">
          {(displayName || email || "?")[0].toUpperCase()}
        </div>
        <div>
          <h2 className="text-lg font-heading font-semibold text-foreground">Your Profile</h2>
          <p className="text-xs text-muted-foreground">{user?.email}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-muted-foreground font-heading block mb-1">Display Name</label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Enter your display name"
            className="bg-muted/30 border-border"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground font-heading block mb-1">Email</label>
          <Input value={email} disabled className="bg-muted/30 border-border opacity-60" />
        </div>
      </div>

      <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading text-sm">
        {saving ? "Saving..." : "Save Profile"}
      </Button>
    </div>
  );
}

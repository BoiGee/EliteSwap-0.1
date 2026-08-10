import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";

interface PendingRequest {
  purge_after: string;
  cancelled_at: string | null;
  purged_at: string | null;
}

export default function DeleteAccountSection() {
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("account_deletion_requests" as any)
      .select("purge_after, cancelled_at, purged_at")
      .eq("user_id", user.id)
      .is("purged_at", null)
      .is("cancelled_at", null)
      .maybeSingle()
      .then(({ data }) => setPending(data as any));
  }, [user]);

  const requestDeletion = async () => {
    setSubmitting(true);
    const { data, error } = await supabase.functions.invoke("request-account-deletion", {
      body: {},
    });
    setSubmitting(false);
    if (error || (data as any)?.code) {
      toast({
        title: "Could not delete account",
        description: (data as any)?.message ?? error?.message ?? "Try again later",
        variant: "destructive",
      });
      return;
    }
    toast({
      title: "Account scheduled for deletion",
      description: "All your data will be permanently removed within 7 days. Email support to cancel.",
    });
    await signOut();
    navigate("/");
  };

  return (
    <div className="glass rounded-2xl p-6 space-y-4 border border-destructive/30">
      <div>
        <h2 className="text-lg font-heading font-semibold text-destructive">Delete Account</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Permanently removes your profile, payments, keys, and all related data from our servers within 7 days.
        </p>
      </div>

      {pending ? (
        <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm space-y-1">
          <p className="font-heading font-semibold">Deletion pending</p>
          <p className="text-xs">
            Your account and data will be permanently purged on{" "}
            <span className="font-mono">{new Date(pending.purge_after).toLocaleString()}</span>.
            Contact support to cancel before then.
          </p>
        </div>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="font-heading text-sm">
              Delete my account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                You will be signed out immediately and unable to sign back in.
                All your data — profile, payments, unique keys, support history, reviews —
                will be permanently wiped from our servers within 7 days.
                This cannot be undone after the 7-day grace period.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep my account</AlertDialogCancel>
              <AlertDialogAction
                onClick={requestDeletion}
                disabled={submitting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {submitting ? "Submitting..." : "Yes, delete everything"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

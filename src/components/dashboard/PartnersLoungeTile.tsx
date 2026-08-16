import { useNavigate } from "react-router-dom";
import { Handshake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePartner } from "@/hooks/usePartner";

export default function PartnersLoungeTile() {
  const navigate = useNavigate();
  const { partner, loading } = usePartner();

  if (loading) return null;
  if (!partner || !partner.is_active) return null;

  return (
    <div className="glass border border-border rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-primary/10 text-primary">
          <Handshake className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-heading font-semibold text-foreground">Partners Lounge</h3>
          <p className="text-xs text-muted-foreground">
            Private space to swap strategies with other partners.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => navigate("/forum/c/partners-lounge")}
        className="font-heading shrink-0"
      >
        Enter Lounge
      </Button>
    </div>
  );
}

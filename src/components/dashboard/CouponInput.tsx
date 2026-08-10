import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface AppliedDiscount {
  code: string;
  percent_off: number;
  discount_usd: number;
  final_usd: number;
}

interface Props {
  planId: string | null;
  planUsd: number | null;
  applied: AppliedDiscount | null;
  onApply: (d: AppliedDiscount | null) => void;
}

export default function CouponInput({ planId, planUsd, applied, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApply = async () => {
    setError(null);
    if (!code.trim()) return;
    if (!planId || planUsd == null) {
      setError("Select a plan first");
      return;
    }
    setLoading(true);
    const { data, error: rpcErr } = await supabase.rpc("validate_discount_code" as any, {
      p_code: code.trim(),
      p_plan_id: planId,
    });
    setLoading(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.valid) {
      setError(row?.reason ?? "Invalid code");
      onApply(null);
      return;
    }
    onApply({
      code: code.trim().toUpperCase(),
      percent_off: row.percent_off,
      discount_usd: Number(row.discount_usd),
      final_usd: Number(row.final_usd),
    });
  };

  const clear = () => {
    setCode("");
    setError(null);
    onApply(null);
  };

  if (!open && !applied) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-primary font-heading hover:underline"
      >
        Have a discount code?
      </button>
    );
  }

  if (applied) {
    return (
      <div className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 flex items-center justify-between gap-3">
        <div className="text-xs">
          <span className="font-heading font-semibold text-primary">{applied.code}</span>
          <span className="text-foreground/80"> · −${applied.discount_usd.toFixed(2)} ({applied.percent_off}% off)</span>
          <span className="text-muted-foreground"> · final ${applied.final_usd.toFixed(2)}</span>
        </div>
        <button onClick={clear} className="text-xs text-muted-foreground hover:text-destructive font-heading">
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Enter code"
          className="h-9 text-sm font-mono uppercase"
          maxLength={32}
        />
        <Button onClick={handleApply} disabled={loading} size="sm" className="font-heading text-xs">
          {loading ? "..." : "Apply"}
        </Button>
        <Button onClick={() => { setOpen(false); setError(null); }} variant="outline" size="sm" className="font-heading text-xs">
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

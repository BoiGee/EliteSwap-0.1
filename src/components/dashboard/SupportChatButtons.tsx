import { Button } from "@/components/ui/button";
import { MessageCircle, Send } from "lucide-react";
import { telegramLink, whatsappLink } from "@/lib/support";

/** WhatsApp + Telegram buttons, side by side. Renders nothing if neither is configured. */
export default function SupportChatButtons({ message, size = "sm", className = "" }: { message: string; size?: "sm" | "default"; className?: string }) {
  const wa = whatsappLink(message);
  const tg = telegramLink();
  if (!wa && !tg) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {wa && (
        <Button size={size} variant="outline" className="font-heading text-xs gap-1.5" asChild>
          <a href={wa} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-3.5 w-3.5" />WhatsApp</a>
        </Button>
      )}
      {tg && (
        <Button size={size} variant="outline" className="font-heading text-xs gap-1.5" asChild>
          <a href={tg} target="_blank" rel="noopener noreferrer"><Send className="h-3.5 w-3.5" />Telegram</a>
        </Button>
      )}
    </div>
  );
}

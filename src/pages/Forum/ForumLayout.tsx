import { ReactNode } from "react";
import AppHeader from "@/components/AppHeader";

export default function ForumLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader active="forum" />
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 md:p-6">{children}</main>
    </div>
  );
}

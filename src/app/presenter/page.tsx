import { notFound } from "next/navigation";
import { presenterGate } from "@/lib/demo-mode/presenter";
import { PresenterForm } from "./PresenterForm";

export const dynamic = "force-dynamic";

export default function PresenterPage() {
  if (!presenterGate(process.env as Record<string, string | undefined>).allowed) notFound();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">NewQuip demonstration</h1>
      <p className="text-sm text-slate-600">Presenter sign-in for the demonstration environment. Enter the access key you were given.</p>
      <PresenterForm />
    </main>
  );
}

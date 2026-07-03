import { NextResponse } from "next/server";
import { createSessionClient } from "@/supabase/server-session";

/** Magic-link redirect target — exchanges the emailed code for a real session cookie, then sends the user in. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createSessionClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}

import { NextResponse } from "next/server";

// The portal has no session logic. This file exists so the portal always runs THIS (empty) proxy: with the repo root as the Turbopack root, Next would otherwise discover the INTERNAL
// application's src/middleware.ts. A test asserts the built manifest contains no internal middleware.
export function proxy() { return NextResponse.next(); }
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };

import { handleFastReactPost } from "../../../lib/fastreact-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleFastReactPost(request);
}

import { handleExclusionPost } from "../../../lib/exclusion-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleExclusionPost(request);
}

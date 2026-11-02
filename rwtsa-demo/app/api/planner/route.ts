import { handlePlannerPost } from "../../../lib/planner-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handlePlannerPost(request);
}

import { handleDownload } from "../../../../lib/fastreact-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleDownload(request);
}

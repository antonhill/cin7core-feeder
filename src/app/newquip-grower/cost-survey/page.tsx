import { notFound } from "next/navigation";
import { authoriseActor } from "../actor";
import { SurveyClient } from "./SurveyClient";

// Internal, cost-bearing, never cached, read-only. 404 unless the viewer is a cost-entitled NewQuip user outside Demo Mode (the actions re-check). Renders only; writes nothing.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function CostSurveyPage() {
  try { const a = await authoriseActor(); if (a.demo || !a.canSeeCost) notFound(); } catch { notFound(); }
  return <SurveyClient />;
}

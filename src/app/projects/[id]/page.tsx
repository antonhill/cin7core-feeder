"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ProjectWorkspace } from "./ProjectWorkspace";

function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  // The Claims list (/claims) links here with ?tab=claims. Read through the router (same value on server and client), so there is no hydration mismatch.
  const openClaims = useSearchParams().get("tab") === "claims";
  return <ProjectWorkspace key={id} id={id} initialTab={openClaims ? "claims" : undefined} />;
}

export default function ProjectDetailPage() {
  return (
    <Suspense fallback={null}>
      <ProjectDetail />
    </Suspense>
  );
}

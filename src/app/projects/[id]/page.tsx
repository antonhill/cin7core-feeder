"use client";

import { useParams } from "next/navigation";
import { ProjectWorkspace } from "./ProjectWorkspace";

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectWorkspace id={id} />;
}

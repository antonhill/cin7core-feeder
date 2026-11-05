import { pageContainerClass } from "@/app/PageContainer";
import { WorkspaceSkeleton } from "./LoadingSkeletons";

// UX-007: the project workspace's final structure at once, while the project is being opened.
export default function Loading() {
  return <main className={pageContainerClass("data")}><WorkspaceSkeleton /></main>;
}

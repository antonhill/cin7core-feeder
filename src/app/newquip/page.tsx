import { redirect } from "next/navigation";
import { NEWQUIP_LOGIN_PATH } from "@/newquip/entry";

export default function NewquipEntryPage() {
  redirect(NEWQUIP_LOGIN_PATH);
}

import { ImportWizard } from "@/components/ImportWizard";
import { listPeopleWithEmail } from "@/server/queries/people";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const existing = await listPeopleWithEmail();
  return (
    <div className="grid gap-4 max-w-3xl">
      <h1 className="text-xl font-semibold">Import people from CSV</h1>
      <ImportWizard existing={existing} />
    </div>
  );
}

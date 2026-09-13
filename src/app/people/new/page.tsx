import { emptyPerson, PersonForm } from "@/components/PersonForm";
import { getCadenceOverrides } from "@/server/queries/settings";

export const dynamic = "force-dynamic";

export default async function NewPersonPage() {
  const overrides = await getCadenceOverrides();
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">New person</h1>
      <div className="card"><PersonForm initial={emptyPerson} cadenceOverrides={overrides} /></div>
    </div>
  );
}

import { notFound } from "next/navigation";
import { PersonForm } from "@/components/PersonForm";
import { getPerson } from "@/server/queries/person";
import { getCadenceOverrides } from "@/server/queries/settings";

export const dynamic = "force-dynamic";

export default async function EditPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [p, overrides] = await Promise.all([getPerson(id), getCadenceOverrides()]);
  if (!p) notFound();
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Edit {p.fullName}</h1>
      <div className="card">
        <PersonForm
          cadenceOverrides={overrides}
          initial={{
            id: p.id,
            fullName: p.fullName,
            preferredName: p.preferredName ?? "",
            email: p.email ?? "",
            phone: p.phone ?? "",
            company: p.company ?? "",
            title: p.title ?? "",
            location: p.location ?? "",
            howWeMet: p.howWeMet ?? "",
            notes: p.notes ?? "",
            roles: p.roles,
            tags: p.tags.join(", "),
            cadenceDays: p.cadenceDays?.toString() ?? "",
            lpStage: p.lpStage ?? "",
            dealSourceQuality: p.dealSourceQuality ?? "",
          }}
        />
      </div>
    </div>
  );
}

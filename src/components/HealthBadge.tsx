import { HEALTH_LABELS, type Health } from "@/domain/enums";

const styles: Record<Health, string> = {
  cold: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  due: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  never: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  warm: "bg-yellow-50 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200",
  fresh: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  no_cadence: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
};

export function HealthBadge({ health }: { health: Health }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[health]}`}
      data-health={health}
    >
      {HEALTH_LABELS[health]}
    </span>
  );
}

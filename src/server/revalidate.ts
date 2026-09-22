import { revalidatePath } from "next/cache";

/** Revalidate app routes after a write. Safe to call outside a request (tests). */
export function revalidateApp(extra: string[] = []): void {
  for (const path of ["/", "/people", ...extra]) {
    try {
      revalidatePath(path);
    } catch {
      // Outside a Next request context (e.g. vitest); nothing to invalidate.
    }
  }
}

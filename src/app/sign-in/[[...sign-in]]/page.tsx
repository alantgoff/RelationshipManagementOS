import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { clerkEnabled } from "@/server/auth";

export default function SignInPage() {
  if (!clerkEnabled) {
    return (
      <div className="card max-w-md mx-auto text-sm">
        <p className="font-medium">Development mode</p>
        <p className="text-muted mt-1">
          Clerk keys are not configured, so you are signed in as the development user.
        </p>
        <Link href="/" className="btn btn-primary mt-4">
          Open dashboard
        </Link>
      </div>
    );
  }
  return (
    <div className="flex justify-center py-10">
      <SignIn />
    </div>
  );
}

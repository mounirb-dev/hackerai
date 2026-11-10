import { isLocalPath, signupsAllowed } from "@/lib/selfhost/config";
import { AuthForm } from "../AuthForm";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  return (
    <AuthForm
      mode="sign-in"
      redirect={isLocalPath(redirect) ? redirect : undefined}
      signupsOpen={signupsAllowed()}
    />
  );
}

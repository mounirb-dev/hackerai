import { handleAuth } from "@workos-inc/authkit-nextjs";

// Local accounts have no OAuth redirect to complete. The path is kept so old
// bookmarks and Desktop links land on the app instead of a 404.
export const GET = handleAuth();

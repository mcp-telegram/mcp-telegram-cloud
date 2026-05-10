/** Locale-aware navigation primitives — these wrap next/link, useRouter, and
 * usePathname so locale prefixes are added/stripped automatically. Always
 * import from here in the app, never directly from `next/link`. */

import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);

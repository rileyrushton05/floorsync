import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DEFAULT_THEME, isThemeId, THEME_COOKIE } from "@/components/themes";
import { Providers } from "./providers";
import "./styles.css";

export const metadata: Metadata = { title: "FloorSync", description: "Job shop scheduling operations" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Read here rather than on the client so the first paint is already themed.
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isThemeId(saved) ? saved : DEFAULT_THEME;

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className="min-h-dvh bg-bg font-sans text-fg">
        <Providers theme={theme}>{children}</Providers>
      </body>
    </html>
  );
}

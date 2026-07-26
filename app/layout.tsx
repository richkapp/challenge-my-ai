import type { Metadata } from "next";
import "./globals.css";

const siteUrl = new URL("https://challenge-my-ai.vercel.app");
const title = "Challenge My AI — Community model fusion";
const description = "Pool model capacity the community already has. Challenge hard questions, reward useful perspectives, and fuse the strongest reasoning into better answers.";

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title,
  description,
  applicationName: "Challenge My AI",
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: "/", siteName: "Challenge My AI", title, description },
  twitter: { card: "summary_large_image", title, description },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

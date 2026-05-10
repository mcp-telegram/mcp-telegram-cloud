import type { MetadataRoute } from "next";
import { config } from "@/lib/config";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: config.issuer, lastModified: now, changeFrequency: "monthly", priority: 1 },
    { url: `${config.issuer}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${config.issuer}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}

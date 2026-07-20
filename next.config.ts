import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pdf-parse", "mammoth", "@prisma/client"],
  experimental: { serverActions: { bodySizeLimit: "50mb" } },
};

export default config;

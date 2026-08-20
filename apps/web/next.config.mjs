import { networkInterfaces } from 'node:os';

const allowedDevOrigins = Array.from(
  new Set(
    Object.values(networkInterfaces()).flatMap((addresses) =>
      (addresses ?? [])
        .filter((address) => address.family === 'IPv4' || address.family === 4)
        .map((address) => address.address),
    ),
  ),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins,
  distDir: process.env.AGENT_PARTY_TIME_NEXT_DIST_DIR ?? '.next',
};

export default nextConfig;

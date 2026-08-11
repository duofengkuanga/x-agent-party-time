/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['10.10.96.169'],
  distDir: process.env.AGENT_PARTY_TIME_NEXT_DIST_DIR ?? '.next',
};

export default nextConfig;

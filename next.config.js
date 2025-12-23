/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for easier deployment
  output: 'standalone',
  
  // Allow images from any domain (for camera streams)
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: '**',
      },
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
}

module.exports = nextConfig




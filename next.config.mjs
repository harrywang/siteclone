/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': ['./dist-electron/**', './electron/server/**', './output/**'],
  },
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/playwright-core/**'],
  },
  serverExternalPackages: ['playwright-core', 'cheerio'],
}

export default nextConfig

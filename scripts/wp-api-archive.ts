/**
 * Rebuild a static, browsable site from the WordPress REST API.
 *
 * A crawler is the right tool when the front end works. It isn't when the front
 * end is gone: blog.hiddenart.ai 302s every page request to a domain that no
 * longer serves the blog, so every URL is unreachable even though the posts are
 * still there. The REST API still answers, so the writing is recoverable — but
 * only until the host is cancelled.
 *
 * Produces an index plus one page per post, with images pulled local, so the
 * archive stands on its own without WordPress, a database, or the origin.
 *
 * Usage: npx tsx scripts/wp-api-archive.ts <dir-with-_api> <host> <server-ip>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'

const [dirArg, host, ip] = process.argv.slice(2)
if (!dirArg || !host || !ip) {
  console.error('Usage: tsx scripts/wp-api-archive.ts <dir> <host> <server-ip>')
  process.exit(1)
}
const root = path.resolve(dirArg)

setGlobalDispatcher(
  new Agent({
    connect: {
      rejectUnauthorized: false,
      lookup: (
        _h: string,
        opts: { all?: boolean },
        cb: (
          e: Error | null,
          a: string | Array<{ address: string; family: number }>,
          f?: number,
        ) => void,
      ) => (opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
    },
  }),
)

interface Post {
  id: number
  slug: string
  date: string
  link: string
  title: { rendered: string }
  content: { rendered: string }
  excerpt: { rendered: string }
}

async function load(kind: string): Promise<Post[]> {
  const f = path.join(root, `_api/${kind}.json`)
  if (!existsSync(f)) return []
  const raw = JSON.parse(await readFile(f, 'utf-8'))
  return Array.isArray(raw) ? raw : []
}

// Pages matter as much as posts: a conference site is *all* pages (Program,
// CFP, Committee) and would otherwise archive as an empty index.
const posts: Post[] = [...(await load('posts')), ...(await load('pages'))]
posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
if (posts.length === 0) {
  console.error('  nothing to archive — no posts or pages in _api/')
  process.exit(1)
}

// Pull every image the posts reference, and point the HTML at the local copy.
const downloaded = new Map<string, string>()
async function localize(html: string, depth: number): Promise<string> {
  const urls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+\.(?:png|jpe?g|gif|webp|svg))"/gi)]
  let out = html
  for (const m of urls) {
    const remote = m[1]
    let rel = downloaded.get(remote)
    if (!rel) {
      let u: URL
      try {
        u = new URL(remote)
      } catch {
        continue
      }
      if (!u.hostname.endsWith(host.replace(/^[^.]+\./, ''))) continue // off-site: leave alone
      rel = 'media/' + path.basename(decodeURIComponent(u.pathname))
      const abs = path.join(root, rel)
      if (!existsSync(abs)) {
        try {
          const res = await fetch(remote)
          if (!res.ok) continue
          await mkdir(path.dirname(abs), { recursive: true })
          await writeFile(abs, Buffer.from(await res.arrayBuffer()))
        } catch {
          continue
        }
      }
      downloaded.set(remote, rel)
    }
    const prefix = '../'.repeat(depth)
    out = out.split(remote).join(prefix + rel)
  }
  return out
}

const shell = (title: string, body: string, depth: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{max-width:46rem;margin:0 auto;padding:2rem 1.25rem;
      font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a}
 img{max-width:100%;height:auto}
 pre{overflow-x:auto;background:#f6f8fa;padding:1rem;border-radius:6px}
 a{color:#0b6bcb}
 .meta{color:#666;font-size:.9rem}
 hr{border:0;border-top:1px solid #e5e5e5;margin:2rem 0}
</style></head><body>
${depth > 0 ? '<p><a href="../index.html">&larr; All posts</a></p>' : ''}
${body}
</body></html>`

await mkdir(path.join(root, 'posts'), { recursive: true })

for (const p of posts) {
  const body = `<h1>${p.title.rendered}</h1>
<p class="meta">${new Date(p.date).toDateString()}</p>
<hr>
${await localize(p.content.rendered, 1)}`
  await writeFile(path.join(root, 'posts', `${p.slug}.html`), shell(p.title.rendered, body, 1), 'utf-8')
}

const list = posts
  .map(
    (p) =>
      `<li><a href="posts/${p.slug}.html">${p.title.rendered}</a> ` +
      `<span class="meta">— ${new Date(p.date).toDateString()}</span></li>`,
  )
  .join('\n')

await writeFile(
  path.join(root, 'index.html'),
  shell(
    'HiddenArt Blog — archive',
    `<h1>HiddenArt Blog</h1>
<p class="meta">Archived from ${host} — ${posts.length} posts. The original site's front end
redirected to a page that no longer exists, so this was rebuilt from the WordPress API.</p>
<hr>
<ul>\n${list}\n</ul>`,
    0,
  ),
  'utf-8',
)

console.log(`  rebuilt ${posts.length} posts, ${downloaded.size} images localized`)

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const distServerRoot = path.join(process.cwd(), 'dist-server')
await rewriteRelativeImports(distServerRoot)

async function rewriteRelativeImports(root) {
  const entries = await readdir(root, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await rewriteRelativeImports(entryPath)
      continue
    }

    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue
    }

    const original = await readFile(entryPath, 'utf8')
    const rewritten = original
      .replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, rewriteSpecifier)
      .replace(/(import\s*\(\s*['"])(\.\.?\/[^'"]+)(['"]\s*\))/g, rewriteSpecifier)

    if (rewritten !== original) {
      await writeFile(entryPath, rewritten, 'utf8')
    }
  }
}

function rewriteSpecifier(_match, prefix, specifier, suffix) {
  if (hasKnownExtension(specifier)) {
    return `${prefix}${specifier}${suffix}`
  }

  return `${prefix}${specifier}.js${suffix}`
}

function hasKnownExtension(specifier) {
  return /\.(?:[cm]?js|json)$/i.test(specifier)
}

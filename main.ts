// Hands in the make.fun frontend (Node 22, standard library only, no network): copies app/ and screenshots/ from
// this repository into the output directory and writes dossier.json there with the kit's vendored buildDossier.
// The output directory is /output in the grader and MAKEFUN_OUTPUT_DIR elsewhere:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Every byte written depends only on the repository's files, so two runs write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-frontend.ts';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const SCORER_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 3, max_bytes: 262144 },
  app_max_files: 993,
  app_max_bytes: 16777216,
  app_path_max_bytes: 1000,
};

/** Copy a directory tree of plain files, in sorted order; anything that is not a file or directory is refused. */
function copyPlainTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyPlainTree(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
    else throw new Error(`refusing to copy ${source}: not a plain file or directory`);
  }
}

function handIn(): void {
  mkdirSync(outputDir, { recursive: true });
  for (const part of ['app', 'screenshots']) {
    const target = join(outputDir, part);
    rmSync(target, { recursive: true, force: true });
    const source = join(repositoryRoot, part);
    if (existsSync(source)) copyPlainTree(source, target);
    else mkdirSync(target, { recursive: true });
  }
  const dossier = buildDossier(outputDir, SCORER_CAPS);
  writeFileSync(join(outputDir, 'dossier.json'), dossier);
  console.log(`wrote ${join(outputDir, 'dossier.json')} (${dossier.byteLength} bytes)`);
}

handIn();

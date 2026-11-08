import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright-core';
import { studioFixtureImage } from './studio-fixture-image.js';

const source = fileURLToPath(new URL('./listmonk-capture/studio-fixture.ts', import.meta.url));
const result = JSON.parse(
  execFileSync(process.execPath, ['--import', 'tsx', source, '--column-images'], { encoding: 'utf8' }),
) as { html: string; text: string; digest: string };
const bytes = await studioFixtureImage('#8b4764');
assert.equal(createHash('sha256').update(bytes).digest('hex'), result.digest);
const html = result.html.replaceAll(
  'src="cid:' + result.digest + '"',
  'src="data:image/png;base64,' + bytes.toString('base64') + '"',
);
const proofs = process.env.FLOCKLETTER_STUDIO_PROOF_DIR;
if (proofs) await mkdir(proofs, { recursive: true });
const browser = await webkit.launch();
try {
  for (const width of [900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 830 }, deviceScaleFactor: 1 });
    const thirdParty = new Set<string>();
    await page.route(/^https?:\/\//, (route) => {
      thirdParty.add(route.request().url());
      return route.abort();
    });
    await page.setContent(html);
    await page.getByRole('heading', { name: 'November at the trailhead' }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Browse the collection' }).getAttribute('href'),
      'https://example.org/collection',
    );
    const images = page.getByRole('img');
    assert.deepEqual(
      await images.evaluateAll((els) => els.map((el) => (el as HTMLImageElement).naturalWidth)),
      [480, 480, 480],
    );
    assert.deepEqual(await images.evaluateAll((els) => els.map((el) => el.getAttribute('alt'))), [
      'Mountain skyline at the trailhead',
      'Breck pickup skyline',
      'Trail report skyline',
    ]);
    const imageWidths = () =>
      images.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    assert.deepEqual(await imageWidths(), width === 390 ? [358, 358, 358] : [552, 268, 268]);
    assert.equal(await page.locator('script').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const left = await page.locator('.fl-column').nth(0).boundingBox(),
      right = await page.locator('.fl-column').nth(1).boundingBox();
    assert(left && right);
    if (width === 390) assert(right.y >= left.y + left.height - 1, 'mobile columns stack');
    else assert(right.x >= left.x + left.width - 1, 'desktop columns are side by side');
    assert.deepEqual([...thirdParty], []);
    if (proofs)
      await page.screenshot({
        path: path.join(proofs, 'studio-email-' + (width === 390 ? 'mobile' : 'desktop') + '.png'),
        fullPage: true,
      });
    if (width === 900) {
      // Some clients ignore image CSS. Exercise the actual numeric HTML fallback.
      await page.locator('img').evaluateAll((els) => els.forEach((el) => el.removeAttribute('style')));
      assert.deepEqual(await imageWidths(), [552, 268, 268]);
      const leftImage = await images.nth(1).boundingBox(),
        rightImage = await images.nth(2).boundingBox();
      assert(leftImage && rightImage);
      assert(leftImage.x >= left.x && leftImage.x + leftImage.width <= left.x + left.width);
      assert(rightImage.x >= right.x && rightImage.x + rightImage.width <= right.x + right.width);
    }
    await page.close();
  }
  console.log(
    'WebKit verified responsive root and column images, desktop HTML width fallbacks, original inline source, link destinations and no external requests.',
  );
} finally {
  await browser.close();
}

import type { Page } from 'playwright-core';

/** Exercise the ordinary rejection control before unrelated browser journeys. */
export async function rejectOptionalCookies(page: Page) {
  await page.locator('[data-cookie-preferences-ready="true"]').waitFor();
  const reject=page.getByRole('button',{name:'Reject optional cookies',exact:true});
  if(await reject.isVisible()) await reject.click();
  await page.locator('#flockletter-cookie-notice').waitFor({state:'hidden'});
}

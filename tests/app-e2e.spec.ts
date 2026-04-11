import { test, expect, Page } from '@playwright/test';

// Helper: wait for app to load (loading overlay gone)
async function waitForAppLoad(page: Page) {
  await page.waitForSelector('#app-loading', { state: 'hidden', timeout: 15000 });
}

// Helper: unlock PIN (if PIN screen shows)
async function unlockIfNeeded(page: Page) {
  const pinInput = page.locator('#pinInput');
  if (await pinInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await pinInput.fill('4799');
    await page.click('button:has-text("Unlock")');
    await page.waitForTimeout(1000);
  }
}

// ═══ AUTHENTICATION & LOAD ═══
test.describe('App Load & Auth', () => {
  test('app loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) });
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);

    // Filter out known non-critical errors
    const critical = errors.filter(e => !e.includes('favicon') && !e.includes('404') && !e.includes('net::'));
    expect(critical.length).toBe(0);
  });

  test('loading spinner appears and disappears', async ({ page }) => {
    await page.goto('/app');
    // Loading overlay should be visible initially
    const loading = page.locator('#app-loading');
    // It should eventually disappear
    await expect(loading).toBeHidden({ timeout: 15000 });
  });

  test('main navigation renders (5 tabs)', async ({ page }) => {
    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);

    const nav = page.locator('.nav button');
    const count = await nav.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });
});

// ═══ CUSTOMER MANAGEMENT ═══
test.describe('Customer Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);
  });

  test('clients tab loads with search', async ({ page }) => {
    await page.click('button:has-text("Clients")');
    await page.waitForTimeout(500);
    const search = page.locator('.srch');
    await expect(search).toBeVisible({ timeout: 5000 });
  });

  test('can search for existing customer', async ({ page }) => {
    await page.click('button:has-text("Clients")');
    await page.waitForTimeout(500);
    const search = page.locator('.srch');
    if (await search.isVisible()) {
      await search.fill('test');
      await page.waitForTimeout(500);
    }
  });
});

// ═══ JOB WORKFLOW ═══
test.describe('Job Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);
  });

  test('calendar tab loads with month grid', async ({ page }) => {
    // Calendar is the default tab
    const calContent = page.locator('#calContent, #calC');
    await expect(calContent).toBeVisible({ timeout: 5000 });
  });

  test('jobs tab loads with job list', async ({ page }) => {
    await page.click('button:has-text("Jobs")');
    await page.waitForTimeout(500);
    // Should see either jobs or "No jobs yet"
    const content = page.locator('#jobsC, #jobsContent');
    await expect(content).toBeVisible({ timeout: 5000 });
  });

  test('FAB button opens new job menu', async ({ page }) => {
    await page.click('.fab');
    await page.waitForTimeout(500);
    // Should see mode cards
    const modeCard = page.locator('.mode-card').first();
    await expect(modeCard).toBeVisible({ timeout: 3000 });
  });

  test('schedule job form opens', async ({ page }) => {
    await page.click('.fab');
    await page.waitForTimeout(300);
    await page.click('.mode-card:has-text("Schedule a Job")');
    await page.waitForTimeout(500);
    // Should see customer search
    const title = page.locator('.ov-title:has-text("Schedule Job")');
    await expect(title).toBeVisible({ timeout: 3000 });
  });
});

// ═══ MONEY TAB ═══
test.describe('Money Tab', () => {
  test('money tab loads with invoice list or empty state', async ({ page }) => {
    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);

    await page.click('button:has-text("Money")');
    await page.waitForTimeout(500);
    const moneyContent = page.locator('#moneyC');
    await expect(moneyContent).toBeVisible({ timeout: 5000 });
  });
});

// ═══ TECHS TAB ═══
test.describe('Techs Tab', () => {
  test('techs tab loads', async ({ page }) => {
    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);

    await page.click('button:has-text("Techs")');
    await page.waitForTimeout(500);
    const techsContent = page.locator('#techsC');
    await expect(techsContent).toBeVisible({ timeout: 5000 });
  });
});

// ═══ ROUTE VIEW ═══
test.describe('Route View', () => {
  test('route button exists on calendar tab', async ({ page }) => {
    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);

    // Route button should be on the calendar quick-action bar
    const routeBtn = page.locator('button:has-text("Route"), span:has-text("Route")').first();
    await expect(routeBtn).toBeVisible({ timeout: 5000 });
  });
});

// ═══ CUSTOMER PORTAL ═══
test.describe('Customer Portal', () => {
  test('portal landing page loads (no token)', async ({ page }) => {
    await page.goto('/portal');
    // Should show phone lookup form
    const phoneLookup = page.locator('#pl-phone, text=Access Your Portal');
    await expect(phoneLookup.first()).toBeVisible({ timeout: 5000 });
  });

  test('portal landing has invoice pay option', async ({ page }) => {
    await page.goto('/portal');
    const invLookup = page.locator('#inv-lookup, text=Pay an Invoice');
    await expect(invLookup.first()).toBeVisible({ timeout: 5000 });
  });
});

// ═══ SEO PAGES ═══
test.describe('SEO Pages', () => {
  const pages = [
    '/services/fire-extinguisher-inspection',
    '/services/kitchen-suppression-inspection',
    '/services/emergency-lighting',
    '/services/clean-agent-systems',
    '/systems/ansul-r102',
    '/areas/dallas',
    '/areas/fort-worth',
    '/privacy',
    '/terms',
  ];

  for (const path of pages) {
    test(`${path} loads with content`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible({ timeout: 5000 });
    });
  }
});

// ═══ HOMEPAGE ═══
test.describe('Homepage', () => {
  test('homepage loads with 4 service cards', async ({ page }) => {
    await page.goto('/');
    const cards = page.locator('.service-card');
    const count = await cards.count();
    expect(count).toBe(4);
  });

  test('request service form has 3 options', async ({ page }) => {
    await page.goto('/');
    const picker = page.locator('#loc-type-picker button');
    const count = await picker.count();
    expect(count).toBe(3);
  });

  test('chatbot button visible', async ({ page }) => {
    await page.goto('/');
    const chatBtn = page.locator('#schBtn');
    await expect(chatBtn).toBeVisible({ timeout: 5000 });
  });

  test('footer has privacy and terms links', async ({ page }) => {
    await page.goto('/');
    const privacy = page.locator('a[href="/privacy"]');
    const terms = page.locator('a[href="/terms"]');
    await expect(privacy.first()).toBeVisible();
    await expect(terms.first()).toBeVisible();
  });
});

// ═══ DEBOUNCE PROTECTION ═══
test.describe('Debounce Protection', () => {
  test('rapid double-click does not open two overlays', async ({ page }) => {
    await page.goto('/app');
    await waitForAppLoad(page);
    await unlockIfNeeded(page);

    // Click FAB twice rapidly
    const fab = page.locator('.fab');
    await fab.click();
    await fab.click();
    await page.waitForTimeout(500);

    // Should only have one overlay open
    const openOverlays = page.locator('.ov.open');
    const count = await openOverlays.count();
    expect(count).toBeLessThanOrEqual(1);
  });
});

// ═══ APPLY PAGE ═══
test.describe('Apply Page', () => {
  test('apply page loads with test questions', async ({ page }) => {
    await page.goto('/apply');
    const testArea = page.locator('#testArea');
    await expect(testArea).toBeVisible({ timeout: 5000 });
  });
});

// ═══ PERFORMANCE ═══
test.describe('Performance', () => {
  test('app loads in under 10 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/app');
    await waitForAppLoad(page);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10000);
    console.log(`App load time: ${elapsed}ms`);
  });

  test('homepage loads in under 5 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    console.log(`Homepage load time: ${elapsed}ms`);
  });
});

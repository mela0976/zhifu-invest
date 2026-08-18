import { expect, test } from '@playwright/test';

const paths = {
  landing: process.env.E2E_LANDING_PATH || '/',
  activate: process.env.E2E_ACTIVATE_PATH || '/activate.html',
  demoLogin: process.env.E2E_DEMO_LOGIN_PATH || '/',
  projects: process.env.E2E_PROJECTS_PATH || '/projects',
  admin: process.env.E2E_ADMIN_PATH || '/admin',
};

const demoActors = {
  memberA: {
    testId: 'demo-login-member-a',
    name: /會員\s*A|會員甲|Demo\s*Member\s*A/i,
    shellTestId: 'member-home',
    shellName: /會員中心|我的投資|Member/i,
  },
  memberB: {
    testId: 'demo-login-member-b',
    name: /會員\s*B|會員乙|Demo\s*Member\s*B/i,
    shellTestId: 'member-home',
    shellName: /會員中心|我的投資|Member/i,
  },
  admin: {
    testId: 'demo-login-admin',
    name: /引薦人|營運管理|管理員|Admin/i,
    shellTestId: 'admin-dashboard',
    shellName: /營運儀表板|管理後台|Dashboard/i,
  },
};

function actionable(page, testId, name) {
  return page
    .getByTestId(testId)
    .or(page.getByRole('button', { name }))
    .or(page.getByRole('link', { name }))
    .filter({ visible: true })
    .first();
}

async function clickIfVisible(locator, timeout = 2_500) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function loginAs(page, actorName) {
  const actor = demoActors[actorName];
  await page.goto(paths.demoLogin, { waitUntil: 'domcontentloaded' });

  const login = actionable(page, actor.testId, actor.name);
  await expect(
    login,
    `Demo mode must expose a stable login control for ${actorName}.`,
  ).toBeVisible();
  await login.click();

  const shell = page
    .getByTestId(actor.shellTestId)
    .or(page.getByRole('heading', { name: actor.shellName }))
    .first();
  await expect(shell, `${actorName} should land in the correct protected surface.`).toBeVisible();
}

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body?.scrollWidth || 0,
  }));

  expect(
    Math.max(dimensions.document, dimensions.body),
    `Page width ${Math.max(dimensions.document, dimensions.body)}px exceeds viewport ${dimensions.viewport}px.`,
  ).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function accessibilitySmoke(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const hasAccessibleName = (element) =>
      Boolean(
        element.getAttribute('aria-label')?.trim() ||
          element.getAttribute('aria-labelledby')?.trim() ||
          element.getAttribute('title')?.trim() ||
          element.textContent?.trim() ||
          element.querySelector('img[alt]:not([alt=""])'),
      );
    const controlHasLabel = (element) => {
      if (element.type === 'hidden') return true;
      if (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby')) return true;
      if (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)) return true;
      return Boolean(element.closest('label'));
    };

    return {
      titleMissing: !document.title.trim(),
      mainMissing: !document.querySelector('main'),
      h1Count: [...document.querySelectorAll('h1')].filter(visible).length,
      imagesWithoutAlt: [...document.querySelectorAll('img')].filter(
        (element) => visible(element) && !element.hasAttribute('alt'),
      ).length,
      unnamedActions: [...document.querySelectorAll('button, a[href]')].filter(
        (element) => visible(element) && !hasAccessibleName(element),
      ).length,
      unlabeledControls: [...document.querySelectorAll('input, select, textarea')].filter(
        (element) => visible(element) && !controlHasLabel(element),
      ).length,
    };
  });
}

function normalizeRecords(records) {
  return records.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function memberSnapshot(page) {
  const identity = page
    .getByTestId('member-identity')
    .or(page.locator('[aria-label="目前登入會員"]'))
    .first();
  await expect(identity, 'The member surface should identify the current demo member.').toBeVisible();
  await expect(
    identity,
    'The asynchronous member identity must replace the loading placeholder before assertions.',
  ).toHaveAttribute('data-member-id', /^(?!M-——$).+/);

  const identityText = (await identity.getAttribute('data-member-id'))
    || (await identity.textContent())?.replace(/\s+/g, ' ').trim();
  expect(identityText).toBeTruthy();

  const records = page.getByTestId('member-private-record').or(page.locator('[data-private-record]'));
  await expect(records.first(), 'Each demo member needs at least one private fixture for isolation QA.').toBeVisible();

  const recordKeys = await records.evaluateAll((elements) =>
    elements.map(
      (element) =>
        element.getAttribute('data-record-id') || element.textContent || '',
    ),
  );

  return {
    identity: identityText,
    records: normalizeRecords(recordKeys),
    mainText: normalizeRecords([await page.locator('main').innerText()])[0] || '',
  };
}

test.describe('致富投資 mobile and role journeys', () => {
  test.describe.configure({ mode: 'serial' });

  test('landing page is mobile-first, legible, and leads to LINE', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(paths.landing, { waitUntil: 'networkidle' });

    await expect(page).toHaveTitle(/致富投資/);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(
      actionable(page, 'line-add-friend', /加入.*LINE|LINE.*官方帳號|加好友/i),
      'The primary mobile conversion should lead to the linked LINE Official Account.',
    ).toBeVisible();
    await expect(page.getByText(/投資.*風險|非.*投資建議|風險揭露/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /不是把標的放上網.*而是先把判斷方法說清楚/ })).toBeVisible();
    expect(await page.locator('.landing-hero__image').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);

    const menuToggle = page.locator('[data-menu-toggle]');
    await menuToggle.click();
    await expect(menuToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#site-navigation')).toHaveAttribute('data-open', '');
    await page.locator('#site-navigation a[href="#about"]').click();
    await expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('html')).not.toHaveAttribute('data-menu-open', '');

    const filterButtons = page.locator('#project-filters [data-filter]');
    await expect(filterButtons.first()).toBeVisible();
    await expect(page.getByRole('group', { name: '依產業篩選' })).toBeVisible();
    const projectRail = page.getByRole('region', { name: '募資研究輪播' });
    await expect(projectRail).toHaveAttribute('tabindex', '0');
    await projectRail.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(180);
    expect(await projectRail.evaluate((rail) => rail.scrollLeft)).toBeGreaterThan(0);
    await projectRail.evaluate((rail) => rail.scrollTo({ left: 0, behavior: 'auto' }));
    if ((await filterButtons.count()) > 1) {
      await filterButtons.nth(1).click();
      await expect(filterButtons.nth(1)).toHaveAttribute('aria-pressed', 'true');
    }
    await page.getByTestId('project-card').first().getByRole('button', { name: '查看研究摘要' }).click();
    await expect(page.locator('#project-dialog')).toBeVisible();
    await page.locator('#project-dialog [data-dialog-close]').first().click();
    await expect(page.locator('#project-dialog')).not.toBeVisible();
    await expect(page.getByText('左右滑動查看更多研究')).toBeVisible();

    const contrastRatios = await page.evaluate(() => {
      const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = rgb(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const ratio = (foreground, background) => {
        const first = luminance(foreground);
        const second = luminance(background);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      const pair = (selector, backgroundSelector) => ratio(
        getComputedStyle(document.querySelector(selector)).color,
        getComputedStyle(document.querySelector(backgroundSelector)).backgroundColor,
      );
      return [
        pair('.landing-metrics strong', '.landing-platform'),
        pair('.landing-page-count span', '.landing-page'),
        pair('.landing-filter-row .filter-chip:last-child', '.landing-page'),
        pair('.landing-footer__top p', '.landing-footer'),
        pair('.landing-footer__legal', '.landing-footer'),
      ];
    });
    expect(Math.min(...contrastRatios)).toBeGreaterThanOrEqual(4.5);

    await expectNoHorizontalOverflow(page);
    expect(await accessibilitySmoke(page)).toEqual({
      titleMissing: false,
      mainMissing: false,
      h1Count: 1,
      imagesWithoutAlt: 0,
      unnamedActions: 0,
      unlabeledControls: 0,
    });

    await page.getByLabel('你的身分').selectOption('company');
    await page.getByLabel('諮詢類型').selectOption({ label: '企業募資顧問' });
    await page.getByLabel('稱呼').fill('DEMO Playwright 聯絡人');
    await page.getByLabel('聯絡電話').fill('0912345678');
    await page.getByLabel('偏好日期').fill('2026-09-01');
    await page.getByLabel('偏好時段').selectOption({ label: '13:00–17:00' });
    await page.getByLabel('想先討論的事').fill('DEMO：驗證公開顧問預約流程。');
    await page.locator('#booking-form input[name="consent"]').check();
    await page.getByRole('button', { name: '送出預約需求' }).click();
    await expect(page.getByText('預約需求已送出，引薦人確認後會通知你。')).toBeVisible();
  });

  test('language URL, browser preference, manual choice, and history stay in sync', async ({ page, browser }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const separator = paths.landing.includes('?') ? '&' : '?';
    await page.goto(`${paths.landing}${separator}lang=en`, { waitUntil: 'networkidle' });

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('Zhifu Investment | Understand the industry first');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('understand the industry first');
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#site-navigation')).toHaveAttribute('aria-label', 'Primary navigation');
    await expect(page.locator('a[href*="activate.html"]').first()).toHaveAttribute('href', /(?:\?|&)lang=en(?:&|$)/);
    await expect(page.getByTestId('project-card').first()).toContainText(/This fictional fundraising summary|Using companion diagnostics/);
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: '繁體中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
    await expect(page).toHaveTitle('致富投資｜讓資金，先看懂產業');
    await expect(page).toHaveURL(/(?:\?|&)lang=zh-TW(?:&|$)/);
    await expect(page.locator('a[href*="activate.html"]').first()).toHaveAttribute('href', /(?:\?|&)lang=zh-TW(?:&|$)/);

    await page.goBack();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('understand the industry first');
    await expect(page).toHaveURL(/(?:\?|&)lang=en(?:&|$)/);

    const activateSeparator = paths.activate.includes('?') ? '&' : '?';
    await page.goto(`${paths.activate}${activateSeparator}lang=en&sourceCode=REFERRER-NORTH&sourceName=North`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('community identity');
    await expect(page.locator('#activation-code')).toHaveValue('REFERRER-NORTH');
    await expectNoHorizontalOverflow(page);

    await page.goto(new URL('risk.html?lang=en', page.url()).href);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('Investment Risk & Anti-Fraud Notice | Zhifu Investment');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Investment risk and anti-fraud notice');

    const englishBrowser = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } });
    const firstVisit = await englishBrowser.newPage();
    await firstVisit.goto(new URL(paths.landing, page.url()).href);
    await expect(firstVisit.locator('html')).toHaveAttribute('lang', 'en');
    await expect(firstVisit).toHaveURL(/(?:\?|&)lang=en(?:&|$)/);
    await englishBrowser.close();
  });

  test('mobile viewport matrix keeps controls clear, tappable, and safe-area aware', async ({ page }) => {
    for (const width of [320, 360, 375, 390, 412]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(paths.landing, { waitUntil: 'networkidle' });
      await expectNoHorizontalOverflow(page);

      const geometry = await page.evaluate(() => {
        const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
        const strip = box('.demo-strip');
        const header = box('.landing-header');
        const toggle = box('[data-menu-toggle]');
        const primary = box('.landing-action--signal');
        const targetSelectors = [
          '.landing-header .landing-brand',
          '.landing-section-note a',
          '.landing-story a',
          '.landing-footer .landing-brand',
          '.landing-footer__top nav a',
          '.landing-footer__middle .footer__links > a',
          '.landing-footer [data-demo-login]',
        ];
        return {
          stripBottom: strip?.bottom || 0,
          headerTop: header?.top || 0,
          toggle: { width: toggle?.width || 0, height: toggle?.height || 0 },
          primary: { width: primary?.width || 0, height: primary?.height || 0 },
          importantTargetHeights: targetSelectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => element.getBoundingClientRect().height)),
        };
      });
      expect(geometry.headerTop).toBeGreaterThanOrEqual(geometry.stripBottom - 1);
      expect(geometry.toggle.width).toBeGreaterThanOrEqual(44);
      expect(geometry.toggle.height).toBeGreaterThanOrEqual(44);
      expect(geometry.primary.width).toBeGreaterThanOrEqual(44);
      expect(geometry.primary.height).toBeGreaterThanOrEqual(48);
      expect(Math.min(...geometry.importantTargetHeights)).toBeGreaterThanOrEqual(44);

      const menuToggle = page.locator('[data-menu-toggle]');
      await menuToggle.click();
      await expect(menuToggle).toHaveAttribute('aria-label', '關閉選單');
      await expect(page.locator('#site-navigation a').first()).toBeFocused();
      const menuHeights = await page.locator('#site-navigation a').evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height));
      expect(Math.min(...menuHeights)).toBeGreaterThanOrEqual(44);
      const menuScrollY = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(60);
      expect(await page.evaluate(() => window.scrollY)).toBe(menuScrollY);
      await page.keyboard.press('Escape');
      await expect(menuToggle).toBeFocused();
      await expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(menuToggle).toHaveAttribute('aria-label', '開啟選單');

      await expect(page.getByText('左右滑動查看更多研究')).toBeVisible();
      const projectButton = page.locator('[data-project-open]').first();
      await projectButton.scrollIntoViewIfNeeded();
      expect((await projectButton.boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
      await projectButton.click();
      const dialogBox = await page.locator('#project-dialog').boundingBox();
      expect(dialogBox?.x || 0).toBeGreaterThanOrEqual(0);
      expect(dialogBox?.y || 0).toBeGreaterThanOrEqual(0);
      expect((dialogBox?.x || 0) + (dialogBox?.width || 0)).toBeLessThanOrEqual(width);
      expect((dialogBox?.y || 0) + (dialogBox?.height || 0)).toBeLessThanOrEqual(844);
      const dialogActions = page.locator('#project-dialog .dialog__foot .button');
      await expect(dialogActions).toHaveCount(2);
      for (let index = 0; index < (await dialogActions.count()); index += 1) {
        const actionBox = await dialogActions.nth(index).boundingBox();
        expect(actionBox?.height || 0).toBeGreaterThanOrEqual(44);
        expect((actionBox?.y || 0) + (actionBox?.height || 0)).toBeLessThanOrEqual(844);
      }
      await page.locator('#project-dialog [data-dialog-close]').first().click();

      await page.locator('#insights').scrollIntoViewIfNeeded();
      const mobileDock = page.locator('[data-mobile-dock]');
      await expect(mobileDock).toHaveAttribute('data-visible', '');
      expect((await mobileDock.getByRole('link', { name: /開啟 LINE/ }).boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
      await page.locator('.landing-footer').scrollIntoViewIfNeeded();
      await expect(mobileDock).not.toHaveAttribute('data-visible', '');
    }
  });

  test('touch emulation can operate the menu, filters, project dialog, and form', async ({ baseURL, browser }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      locale: 'zh-TW',
    });
    try {
      const page = await context.newPage();
      await page.goto(paths.landing, { waitUntil: 'networkidle' });
      await page.locator('[data-menu-toggle]').tap();
      await page.locator('#site-navigation a[href="#projects"]').tap();
      const filters = page.locator('#project-filters [data-filter]');
      if ((await filters.count()) > 1) await filters.nth(1).tap();
      await page.locator('[data-project-open]').first().tap();
      await expect(page.locator('#project-dialog')).toBeVisible();
      await page.locator('#project-dialog [data-dialog-close]').first().tap();

      const phone = page.getByLabel('聯絡電話');
      await phone.scrollIntoViewIfNeeded();
      await phone.tap();
      await page.setViewportSize({ width: 390, height: 500 });
      await page.waitForTimeout(300);
      await phone.scrollIntoViewIfNeeded();
      const phoneBox = await phone.boundingBox();
      expect(phoneBox?.y || -1).toBeGreaterThanOrEqual(0);
      expect((phoneBox?.y || 0) + (phoneBox?.height || 0)).toBeLessThanOrEqual(500);
      await expect(page.locator('[data-mobile-dock]')).toHaveCSS('opacity', '0');
      await phone.fill('0912345678');
      await expect(phone).toHaveValue('0912345678');
    } finally {
      await context.close();
    }
  });

  test('landing page keeps its ledger layout at tablet and desktop widths', async ({ page }) => {
    for (const viewport of [
      { width: 768, height: 1024 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(paths.landing, { waitUntil: 'networkidle' });
      await expect(page.locator('.landing-signal')).toBeVisible();
      await expect(page.locator('.landing-metrics article')).toHaveCount(4);
      await expectNoHorizontalOverflow(page);
    }
  });

  test('community activation link prefills source tracking fields', async ({ page }) => {
    await page.goto(`${paths.activate}?sourceCode=REFERRER-NORTH&sourceName=${encodeURIComponent('引薦人北區 OpenChat')}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#activation-code')).toHaveValue('REFERRER-NORTH');
    await expect(page.locator('#activation-source')).toHaveValue('引薦人北區 OpenChat');
  });

  test('two demo members receive isolated private records', async ({ baseURL, browser }) => {
    const contextOptions = { baseURL, locale: 'zh-TW', timezoneId: 'Asia/Taipei' };
    const contextA = await browser.newContext(contextOptions);
    const contextB = await browser.newContext(contextOptions);

    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await loginAs(pageA, 'memberA');
      await loginAs(pageB, 'memberB');

      const memberA = await memberSnapshot(pageA);
      const memberB = await memberSnapshot(pageB);

      expect(memberA.identity).not.toBe(memberB.identity);
      expect(memberA.mainText).not.toContain(memberB.identity);
      expect(memberB.mainText).not.toContain(memberA.identity);
      expect(memberA.records.filter((record) => memberB.records.includes(record))).toEqual([]);

      await expectNoHorizontalOverflow(pageA);
      await expectNoHorizontalOverflow(pageB);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('引薦人 sees dashboard KPIs and an actionable operations queue', async ({ page }) => {
    await loginAs(page, 'admin');

    const dashboard = page
      .getByTestId('admin-dashboard')
      .or(page.getByRole('heading', { name: /營運儀表板|管理後台|Dashboard/i }))
      .first();
    await expect(dashboard).toBeVisible();

    const kpis = page.getByTestId('admin-kpi').or(page.locator('[data-kpi]'));
    await expect(kpis.first(), 'The dashboard should render KPI cards as a stable collection.').toBeVisible();
    expect(await kpis.count()).toBeGreaterThanOrEqual(2);
    await expect(
      page
        .getByTestId('admin-action-queue')
        .or(page.getByRole('region', { name: /待辦|行動佇列|Action queue/i }))
        .first(),
    ).toBeVisible();

    await page.locator('[data-admin-nav="bookings"]:visible').first().click();
    await expect(page.getByTestId('admin-booking').first()).toBeVisible();

    await expectNoHorizontalOverflow(page);
  });

  test('admin attributes a high-value member and settles an immutable referral commission', async ({ baseURL, browser }) => {
    const contextOptions = { baseURL, locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 390, height: 844 } };
    const adminContext = await browser.newContext(contextOptions);
    const memberContext = await browser.newContext(contextOptions);
    const approvalReference = `PW-COM-APP-${Date.now()}`;
    const payoutReference = `PW-COM-PAY-${Date.now()}`;
    const evidenceReference = `PW-REF-${Date.now()}`;

    try {
      const adminPage = await adminContext.newPage();
      await loginAs(adminPage, 'admin');
      await adminPage.locator('[data-admin-nav="referrals"]:visible').first().click();
      await expect(adminPage.getByTestId('referral-dashboard')).toBeVisible();

      const visibleReferrers = adminPage.getByTestId('referral-row').filter({ visible: true });
      await expect(visibleReferrers.first()).toBeVisible();
      expect(await visibleReferrers.count()).toBeGreaterThanOrEqual(4);

      const referrerCode = `PW-NETWORK-${Date.now()}`;
      await adminPage.getByRole('button', { name: '新增引薦方' }).click();
      await adminPage.getByLabel('引薦方顯示名稱').fill('Playwright 高階投資圈');
      await adminPage.getByLabel('唯一引薦碼').fill(referrerCode);
      await adminPage.getByLabel('簽約法定名稱').fill('Playwright 投資顧問股份有限公司');
      await adminPage.getByLabel('聯絡人').fill('測試合作窗口');
      await adminPage.getByLabel('聯絡信箱').fill('referral-e2e@example.invalid');
      await adminPage.getByLabel('預設分潤率（bps）').fill('200');
      await adminPage.getByLabel('協議生效日').fill('2026-01-01');
      await adminPage.getByLabel('協議參考編號').fill(`PW-AGR-${Date.now()}`);
      await adminPage.locator('#referrer-reason').fill('Playwright：建立多方高階投資人合作名冊');
      await adminPage.getByTestId('referrer-save').click();
      await expect(adminPage.locator('#referrer-dialog')).not.toBeVisible();
      const createdReferrerRow = adminPage.getByTestId('referral-row').filter({ visible: true }).filter({ hasText: referrerCode });
      await expect(createdReferrerRow).toBeVisible();
      await createdReferrerRow.getByRole('button', { name: '編輯引薦方' }).click();
      await adminPage.getByLabel('預設分潤率（bps）').fill('210');
      await adminPage.locator('#referrer-reason').fill('Playwright：依補充協議調整未來認購比例');
      await adminPage.getByTestId('referrer-save').click();
      await expect(createdReferrerRow).toContainText('210 bps (2.1%)');

      const memberPage = await memberContext.newPage();
      await loginAs(memberPage, 'memberA');
      const member = await memberSnapshot(memberPage);

      await adminPage.locator('[data-admin-nav="members"]:visible').first().click();
      await adminPage.locator('#member-search').fill(member.identity);
      const memberCard = adminPage.locator('.mobile-record:visible').filter({ hasText: member.identity }).first();
      await expect(memberCard).toBeVisible();
      await memberCard.getByRole('button', { name: '確認／管理' }).click();

      const referrerSelect = adminPage.getByTestId('member-referrer-select');
      const currentReferrer = await referrerSelect.inputValue();
      const snapshotReferrer = await referrerSelect.locator('option').evaluateAll((options, current) => (
        options.map((option) => option.value).find((value) => value && value !== current) || ''
      ), currentReferrer);
      expect(snapshotReferrer).toBeTruthy();
      await referrerSelect.selectOption(snapshotReferrer);
      const expectedSnapshotName = (await referrerSelect.locator('option:checked').innerText()).split('｜')[0];
      await adminPage.getByTestId('referral-evidence-reference').fill(evidenceReference);
      await adminPage.locator('#member-reason').fill('Playwright：核對引薦證據並建立認購來源');
      await adminPage.locator('#member-dialog').getByRole('button', { name: '確認並儲存' }).click();
      await expect(adminPage.locator('#member-dialog')).not.toBeVisible();

      await memberPage.locator('[data-nav-view="projects"]:visible').first().click().catch(async () => {
        await memberPage.goto(paths.projects, { waitUntil: 'domcontentloaded' });
      });
      const project = memberPage.getByTestId('project-card').or(memberPage.locator('[data-project-card]')).first();
      await expect(project).toBeVisible();
      const openFromCard = project.getByTestId('subscription-open')
        .or(project.getByRole('link', { name: /查看|詳情|認購/i }))
        .or(project.getByRole('button', { name: /查看|詳情|認購/i }))
        .first();
      if (!(await clickIfVisible(openFromCard))) await project.click();
      await clickIfVisible(actionable(memberPage, 'subscription-open', /提出認購意向|申請認購|開始申請/i));
      const amount = '1900000';
      const amountInput = memberPage.getByTestId('subscription-amount').or(memberPage.getByLabel(/申請金額|認購金額|新台幣/i)).first();
      await amountInput.fill(amount);
      const requiredCheckboxes = memberPage.locator('input[type="checkbox"][required]:visible');
      for (let index = 0; index < (await requiredCheckboxes.count()); index += 1) await requiredCheckboxes.nth(index).check();
      await actionable(memberPage, 'subscription-submit', /送出.*認購|提交.*申請/i).click();
      await expect(memberPage.getByTestId('subscription-status').or(memberPage.getByText(/已送出|待營運確認|submitted/i)).first()).toBeVisible();
      const memberSubscriptionsBeforeSettlement = await memberPage.evaluate(async () => (await fetch('/api/subscriptions')).json());
      const createdSubscription = [...(memberSubscriptionsBeforeSettlement.data || memberSubscriptionsBeforeSettlement.subscriptions || [])]
        .reverse()
        .find((item) => (
          Number(item.requestedAmount ?? item.requestedAmountTwd) === Number(amount)
          && (item.subscriptionState || item.subscriptionStatus) === 'submitted'
        ));
      expect(createdSubscription?.id).toBeTruthy();
      const subscriptionId = createdSubscription.id;

      await adminPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(adminPage.getByTestId('admin-dashboard')).toBeVisible();
      await adminPage.locator('[data-admin-nav="subscriptions"]:visible').first().click();
      const subscriptionRow = adminPage.locator(`[data-testid="subscription-row"][data-subscription-id="${subscriptionId}"]:visible`);
      await expect(subscriptionRow).toBeVisible();
      const advanceSubscription = async (state, finalAmounts = false) => {
        await subscriptionRow.getByTestId('subscription-confirm').click();
        await adminPage.locator('#admin-subscription-status').selectOption(state);
        if (finalAmounts) {
          await adminPage.locator('#admin-approved-amount').fill(amount);
          await adminPage.locator('#admin-received-amount').fill(amount);
          await adminPage.locator('#admin-allocated-amount').fill(amount);
          await adminPage.locator('#admin-refunded-amount').fill('0');
          await adminPage.locator('#admin-partner-reference').fill(`PW-PARTNER-${Date.now()}`);
        }
        await adminPage.getByTestId('operation-reason').fill(`Playwright：推進至 ${state}`);
        await adminPage.getByTestId('operation-confirm-submit').click();
        await expect(adminPage.locator('#subscription-admin-dialog')).not.toBeVisible();
      };
      await advanceSubscription('operations_confirmed');
      await advanceSubscription('partner_review');
      await advanceSubscription('approved', true);

      await adminPage.locator('[data-admin-nav="referrals"]:visible').first().click();
      const commissionRow = adminPage.locator(`[data-testid="commission-row"][data-subscription-id="${subscriptionId}"]:visible`);
      await expect(commissionRow.locator('.status[data-status="accrued"]')).toBeVisible();
      await expect(commissionRow.locator('.snapshot-name')).toHaveText(expectedSnapshotName);

      await adminPage.locator('[data-admin-nav="members"]:visible').first().click();
      await adminPage.locator('#member-search').fill(member.identity);
      await adminPage.locator('.mobile-record:visible').filter({ hasText: member.identity }).first().getByRole('button', { name: '確認／管理' }).click();
      const futureReferrerSelect = adminPage.getByTestId('member-referrer-select');
      const futureReferrer = await futureReferrerSelect.locator('option').evaluateAll((options, previous) => (
        options.map((option) => option.value).find((value) => value && value !== previous) || ''
      ), snapshotReferrer);
      await futureReferrerSelect.selectOption(futureReferrer);
      await adminPage.getByTestId('referral-evidence-reference').fill(`${evidenceReference}-FUTURE`);
      await adminPage.locator('#member-reason').fill('Playwright：改派未來認購，不回寫既有快照');
      await adminPage.locator('#member-dialog').getByRole('button', { name: '確認並儲存' }).click();
      await expect(adminPage.locator('#member-dialog')).not.toBeVisible();

      await adminPage.locator('[data-admin-nav="referrals"]:visible').first().click();
      await expect(commissionRow.locator('.snapshot-name')).toHaveText(expectedSnapshotName);

      await commissionRow.getByRole('button', { name: '審核分潤' }).click();
      await expect(adminPage.getByTestId('commission-action')).toHaveValue('approve');
      await adminPage.getByTestId('commission-approval-reference').fill(approvalReference);
      await adminPage.getByTestId('commission-reason').fill('Playwright：依協議與最終分配金額核准');
      await adminPage.getByTestId('commission-save').click();
      await expect(adminPage.locator('#commission-dialog')).not.toBeVisible();
      await expect(commissionRow.locator('.status[data-status="approved"]')).toBeVisible();

      await commissionRow.getByRole('button', { name: '登錄付款' }).click();
      await expect(adminPage.getByTestId('commission-action')).toHaveValue('pay');
      await adminPage.getByLabel('付款參考編號').fill(payoutReference);
      await adminPage.getByTestId('commission-reason').fill('Playwright：完成財務付款並登錄銀行參考');
      await adminPage.getByTestId('commission-save').click();
      await expect(adminPage.locator('#commission-dialog')).not.toBeVisible();
      await expect(commissionRow.locator('.status[data-status="paid"]')).toBeVisible();
      await expectNoHorizontalOverflow(adminPage);
      expect(await accessibilitySmoke(adminPage)).toEqual({
        titleMissing: false,
        mainMissing: false,
        h1Count: 1,
        imagesWithoutAlt: 0,
        unnamedActions: 0,
        unlabeledControls: 0,
      });

      await memberPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(memberPage.locator('main')).not.toContainText(approvalReference);
      await expect(memberPage.locator('main')).not.toContainText(payoutReference);
      await expect(memberPage.getByTestId('commission-row')).toHaveCount(0);
      const memberSubscriptions = await memberPage.evaluate(async () => (await fetch('/api/subscriptions')).json());
      expect(JSON.stringify(memberSubscriptions)).not.toMatch(/commission(State|Approval|Payment|Accrued|Basis)|referralSnapshot/);
      await expectNoHorizontalOverflow(memberPage);
    } finally {
      await adminContext.close();
      await memberContext.close();
    }
  });

  test('member submits a subscription and operations confirms it', async ({ baseURL, browser }) => {
    const contextOptions = { baseURL, locale: 'zh-TW', timezoneId: 'Asia/Taipei' };
    const memberContext = await browser.newContext(contextOptions);
    const adminContext = await browser.newContext(contextOptions);
    // Seed projects use a TWD 500,000 minimum and TWD 100,000 increments.
    // TWD 1,600,000 is valid and intentionally outside the seeded request range.
    const amount = '1600000';

    try {
      const memberPage = await memberContext.newPage();
      await loginAs(memberPage, 'memberA');
      const member = await memberSnapshot(memberPage);

      const projectsLink = actionable(memberPage, 'nav-projects', /募資專區|企業募資|專案|Projects/i);
      if (!(await clickIfVisible(projectsLink))) {
        await memberPage.goto(paths.projects, { waitUntil: 'domcontentloaded' });
      }

      const project = memberPage
        .getByTestId('project-card')
        .or(memberPage.locator('[data-project-card]'))
        .first();
      await expect(project, 'A qualified Demo member needs an authorized project fixture.').toBeVisible();

      const openFromCard = project
        .getByTestId('subscription-open')
        .or(project.getByRole('link', { name: /查看|詳情|認購/i }))
        .or(project.getByRole('button', { name: /查看|詳情|認購/i }))
        .first();
      if (!(await clickIfVisible(openFromCard))) {
        await project.click();
      }

      await expect(memberPage.getByTestId('protected-company')).toBeVisible();
      await expect(memberPage.getByTestId('approved-report')).toHaveCount(2);

      const openSubscription = actionable(
        memberPage,
        'subscription-open',
        /提出認購意向|申請認購|開始申請/i,
      );
      await clickIfVisible(openSubscription);

      const amountInput = memberPage
        .getByTestId('subscription-amount')
        .or(memberPage.getByLabel(/申請金額|認購金額|新台幣/i))
        .first();
      await expect(amountInput).toBeVisible();
      await amountInput.fill(amount);

      const requiredCheckboxes = memberPage.locator('input[type="checkbox"][required]:visible');
      for (let index = 0; index < (await requiredCheckboxes.count()); index += 1) {
        await requiredCheckboxes.nth(index).check();
      }

      await actionable(memberPage, 'subscription-submit', /送出.*認購|提交.*申請/i).click();
      await expect(
        memberPage
          .getByTestId('subscription-status')
          .or(memberPage.getByText(/已送出|待營運確認|submitted/i))
          .first(),
      ).toBeVisible();

      const adminPage = await adminContext.newPage();
      await loginAs(adminPage, 'admin');

      const subscriptionsLink = actionable(
        adminPage,
        'admin-subscriptions',
        /認購管理|認購申請|Subscriptions/i,
      );
      if (!(await clickIfVisible(subscriptionsLink))) {
        await adminPage.goto(`${paths.admin}/subscriptions`, { waitUntil: 'domcontentloaded' });
      }

      const amountPattern = /1[,.]?600[,.]?000/;
      const rows = adminPage
        .getByTestId('subscription-row')
        .or(adminPage.locator('tr[data-subscription-id]'))
        .filter({ hasText: amountPattern })
        .filter({ hasText: member.identity });
      const row = rows.last();
      await expect(row, 'The submitted member request must enter the admin operations queue.').toBeVisible();

      await row
        .getByTestId('subscription-confirm')
        .or(row.getByRole('button', { name: /營運確認|確認認購|Confirm/i }))
        .first()
        .click();

      const reason = adminPage
        .getByTestId('operation-reason')
        .filter({ visible: true })
        .first();
      await reason.scrollIntoViewIfNeeded();
      await expect(reason).toBeVisible();
      await reason.fill('Playwright Demo 營運確認');
      await actionable(adminPage, 'operation-confirm-submit', /確認並儲存|完成確認/i).click();

      await expect(row.getByText(/營運已確認|operations confirmed/i).first()).toBeVisible();
    } finally {
      await memberContext.close();
      await adminContext.close();
    }
  });
});

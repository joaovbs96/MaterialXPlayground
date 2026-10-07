// tests/embed/site-pages.spec.mjs: the Desktop app, VS Code and About pages, the
// header's Blog link, and the home page's Latest posts strip, which reads
// blog/posts.json (built only at deploy, so it is mocked here).
import { test, expect } from './lib/test-base.mjs';

const POSTS = [
  { title: 'First post', url: 'blog/first/', date: '2026-10-05T00:00:00.000Z', description: 'One.' },
  { title: 'Bad url', url: 'https://example.com/x', date: '2026-10-04T00:00:00.000Z' },
  { title: 'Second post', url: 'blog/second/', date: '2026-10-03T00:00:00.000Z' },
  { title: 'Third post', url: 'blog/third/', date: '2026-10-02T00:00:00.000Z' },
  { title: 'Fourth post', url: 'blog/fourth/', date: '2026-10-01T00:00:00.000Z' },
];

function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test('@smoke Desktop and VS Code pages render and the header links to the blog', async ({ page, embedURL }) => {
  const errors = collectPageErrors(page);
  await page.goto(embedURL + '/index.html#!desktop');
  await expect(page.locator('#desktop-h1')).toHaveText('MaterialX Playground for desktop');
  await expect(page.locator('#desktop-downloads')).toBeVisible();
  await expect(page).toHaveTitle(/Desktop app/);

  await page.goto(embedURL + '/index.html#!vscode');
  await expect(page.locator('#vscode-h1')).toHaveText('MaterialX Playground for VS Code');
  await expect(page.getByText('MaterialXPlayground.materialx-playground').first()).toBeAttached();

  await expect(page.locator('#site-header a[href="blog/"]').first()).toBeAttached();
  expect(errors).toEqual([]);
});

test('Home Latest posts strip validates entries and hides without posts', async ({ page, embedURL }) => {
  await page.route('**/blog/posts.json', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(embedURL + '/index.html#!home');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#home-posts-h')).toHaveCount(0);

  await page.unroute('**/blog/posts.json');
  await page.route('**/blog/posts.json', (route) => route.fulfill({ json: POSTS }));
  await page.reload();
  await expect(page.locator('#home-posts-h')).toBeVisible();
  await expect(page.getByText('First post')).toBeVisible();
  await expect(page.getByText('Third post')).toBeVisible();
  await expect(page.getByText('Bad url')).toHaveCount(0);
  await expect(page.getByText('Fourth post')).toHaveCount(0);
});

test('@smoke About page renders and the header groups highlight their active page', async ({ page, embedURL }) => {
  const errors = collectPageErrors(page);
  await page.goto(embedURL + '/index.html#!about');
  await expect(page.locator('#about-h1')).toHaveText('Render and Learn MaterialX Easily Anywhere');
  await expect(page).toHaveTitle(/The MaterialX Playground/);
  await expect(page.locator('#mtlx-menu-trigger-aboutGroup')).toHaveClass(/is-active/);
  await expect(page.locator('#mtlx-about-btn')).toHaveAttribute('aria-label', 'Build Info & Licenses');

  // The deck is a carousel; the document slides build their source in the
  // page, so these checks need neither a GPU render nor a network fetch.
  const deck = page.locator('#about-deck');
  await expect(deck).toHaveAttribute('aria-roledescription', 'carousel');
  await expect(deck).toHaveAttribute('data-index', '0');
  await page.locator('[data-about-nav="next"]').click();
  await expect(deck).toHaveAttribute('data-slide', 'doc');
  const docSource = page.locator('[data-about-slide="doc"] [data-testid="about-source"]');
  await expect(docSource).toContainText('standard_surface');
  await expect(docSource).not.toContainText('base_color');
  await expect(page.locator('[data-about-slide="intro"]')).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(deck).toHaveAttribute('data-slide', 'color');
  await expect(page.locator('[data-about-slide="color"] [data-testid="about-source"]')).toContainText('base_color');
  await expect(page.locator('[data-about-slide="color"]')).toHaveAttribute('aria-label', /^3 of \d+/);
  // Restart undoes a pick and returns to slide 1 with the deep link cleared.
  const colorSource = page.locator('[data-about-slide="color"] [data-testid="about-source"]');
  await page.locator('[data-about-slide="color"] button', { hasText: 'Teal' }).click();
  await expect(colorSource).toContainText('0.03, 0.42, 0.37');
  await page.locator('[data-about-nav="restart"]').click();
  await expect(deck).toHaveAttribute('data-index', '0');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#!about');
  await page.locator('[data-about-dot="color"]').click();
  await expect(deck).toHaveAttribute('data-slide', 'color');
  await expect(colorSource).toContainText('0.86, 0.16, 0.07');
  // Go further starts on the Dragon with its credit line; Restart brings it back.
  const dragonChip = page.locator('[data-about-shape="dragon"]');
  const dragonCredit = page.locator('[data-about-credit="dragon"]');
  await page.locator('[data-about-dot="further"]').click();
  await expect(deck).toHaveAttribute('data-slide', 'further');
  await expect(dragonChip).toHaveAttribute('aria-pressed', 'true');
  await expect(dragonCredit).toBeVisible();
  await page.locator('[data-about-shape="cube"]').click();
  await expect(dragonCredit).toBeHidden();
  await page.locator('[data-about-nav="restart"]').click();
  await expect(deck).toHaveAttribute('data-index', '0');
  await page.locator('[data-about-dot="further"]').click();
  await expect(dragonChip).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('End');
  await expect(page.locator('#about-next-h')).toHaveText('Out in the open');
  await page.keyboard.press('Home');
  await expect(deck).toHaveAttribute('data-index', '0');

  await page.goto(embedURL + '/index.html#!roadmap');
  await expect(page.locator('#mtlx-menu-trigger-aboutGroup')).toHaveClass(/is-active/);
  await page.evaluate(() => { location.hash = '#!compare'; });
  await expect(page.locator('#mtlx-menu-trigger-viewers')).toHaveClass(/is-active/);
  await expect(page.locator('#mtlx-menu-trigger-aboutGroup')).not.toHaveClass(/is-active/);
  await expect(page.locator('#mtlx-menu-aboutGroup a[href$="/releases"]')).toHaveAttribute('target', '_blank');
  expect(errors).toEqual([]);
});

import { expect, test, type Locator, type Page } from '@playwright/test';

// Runs against a live C4 Studio server (default http://127.0.0.1:47145, override with C4_STUDIO_URL).
// The suite imports its own model, so it needs no fixtures on disk, and deletes it afterwards.

const DSL = `workspace "E2E bank" "Workspace used by the C4 Studio browser tests." {
    model {
        customer = person "Customer" "A customer of the bank."
        banking = softwareSystem "Banking system" "Holds accounts and payments." {
            web = container "Web app" "Serves the single-page app." "React"
            api = container "API" "Business logic." "Node.js"
            db = container "Database" "Stores accounts." "PostgreSQL" "Database"
        }
        mail = softwareSystem "Mail system" "Sends e-mail." "External"

        customer -> web "Uses" "HTTPS"
        web -> api "Calls" "JSON/HTTPS"
        api -> db "Reads from and writes to" "SQL"
        api -> mail "Sends e-mail using" "SMTP"
    }
    views {
        systemLandscape "landscape" "Landscape" {
            include *
        }
        container banking "containers" "Containers" {
            include *
        }
    }
}
`;

let slug = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const res = await request.post('/api/models/import', { data: { dsl: DSL, name: `e2e-${Date.now().toString(36)}` } });
  expect(res.ok(), await res.text()).toBeTruthy();
  slug = ((await res.json()) as { slug: string }).slug;
});

test.afterAll(async ({ request }) => {
  if (slug) await request.delete(`/api/models/${slug}`);
});

const open = async (page: Page, view = 'containers') => {
  await page.goto(`/?model=${slug}&branch=main&view=${view}`);
  await expect(page.getByTestId('c4-canvas')).toBeVisible();
  await expect(page.getByTestId('c4-node').first()).toBeVisible();
};

const node = (page: Page, id: string) => page.locator(`[data-testid="c4-node"][data-element-id="${id}"]`);

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

test('the app loads and shows the model', async ({ page }) => {
  await open(page);
  await expect(page.getByText('C4 Studio', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('model-select')).toHaveValue(slug);
  await expect(page.getByTestId('branch-select')).toHaveValue('main');
  await expect(page.getByTestId('statusbar')).toContainText('revision');
});

test('switching view renders nodes', async ({ page }) => {
  await open(page, 'landscape');
  await expect(page.getByTestId('c4-node')).toHaveCount(3);
  await page.getByLabel('View', { exact: true }).selectOption('containers');
  await expect(page).toHaveURL(/view=containers/);
  await expect(page.getByTestId('c4-node')).toHaveCount(5);
  await expect(page.getByTestId('c4-group')).toHaveCount(1);
  // C4 notation: the type line is always present, never colour alone.
  await expect(node(page, 'banking.db')).toContainText('[Container: PostgreSQL]');
  await expect(node(page, 'customer')).toContainText('[Person]');
  await expect(node(page, 'mail')).toContainText('[Software System]');
});

test('dragging a node persists its position across a reload', async ({ page }) => {
  await open(page);
  const rel = async () => {
    const web = await box(node(page, 'banking.web'));
    const api = await box(node(page, 'banking.api'));
    return { dx: (web.x - api.x) / web.width, dy: (web.y - api.y) / web.width };
  };
  const before = await rel();
  const b = await box(node(page, 'banking.web'));
  const saved = page.waitForResponse((r) => r.url().includes('/layout/') && r.request().method() === 'PUT');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 40, { steps: 10 });
  await page.mouse.up();
  expect((await saved).status()).toBe(204);
  const moved = await rel();
  expect(Math.abs(moved.dx - before.dx) + Math.abs(moved.dy - before.dy)).toBeGreaterThan(0.2);

  await page.reload();
  await expect(node(page, 'banking.web')).toBeVisible();
  const after = await rel();
  expect(after.dx).toBeCloseTo(moved.dx, 1);
  expect(after.dy).toBeCloseTo(moved.dy, 1);
});

test('the labels toggle hides edge labels and hovering an edge shows a tooltip', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('c4-edge-label').first()).toBeVisible();
  await page.getByRole('button', { name: 'Labels: shown' }).click();
  await expect(page.getByRole('button', { name: 'Labels: collapsed' })).toBeVisible();
  await expect(page.getByTestId('c4-edge-label')).toHaveCount(0);

  // Hover the middle of the first edge (a path's bounding-box centre need not lie on the path).
  const point = await page.getByTestId('c4-edge-hit').first().evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  });
  await page.mouse.move(point.x - 20, point.y - 20);
  await page.mouse.move(point.x, point.y, { steps: 5 });
  await expect(page.locator('.pw-tooltip').first()).toBeVisible();
  await expect(page.locator('.pw-tooltip').first()).not.toBeEmpty();
});

test('the theme control toggles data-theme', async ({ page }) => {
  await open(page);
  const html = page.locator('html');
  await page.getByTestId('theme-dark').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-light').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('theme-system').click();
  await expect(html).not.toHaveAttribute('data-theme', /.+/);
});

test('adding an element through the dialog shows a new node, and the render stays fast', async ({ page }) => {
  await open(page);
  const startRevision = await page.evaluate(() => (window as unknown as { __c4studio: { revision: number } }).__c4studio.revision);
  await page.getByRole('button', { name: 'Add element' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Cache');
  await dialog.getByLabel('Technology').fill('Redis');
  await dialog.getByRole('button', { name: 'Add element' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-testid="c4-node"]', { hasText: 'Cache' })).toBeVisible();
  await expect(page.getByTestId('c4-node')).toHaveCount(6);

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __c4studio: { revision: number } }).__c4studio.revision))
    .toBeGreaterThan(startRevision);
  const ms = await page.evaluate(() => (window as unknown as { __c4studio: { lastRenderMs: number } }).__c4studio.lastRenderMs);
  expect(typeof ms).toBe('number');
  expect(ms).toBeLessThan(500);
  await expect(page.getByTestId('status-render')).toContainText(/render \d+ ms/);
});

test('double-clicking or the drill button opens the level below, and breadcrumbs come back up', async ({ page }) => {
  await open(page, 'landscape');
  const system = page.locator('[data-testid="c4-node"][data-element-id="banking"]');
  await expect(system.getByTestId('c4-drill')).toBeVisible();
  await system.dblclick();
  await expect(page).toHaveURL(/view=containers/);
  await expect(page.locator('.c4-crumbs')).toContainText('System landscape');
  await page.locator('.c4-crumbs').getByRole('button', { name: /System landscape/ }).click();
  await expect(page).toHaveURL(/view=landscape/);
  await expect(page).toHaveURL(/element=banking/);
  await system.getByTestId('c4-drill').click();
  await expect(page).toHaveURL(/view=containers/);
});

test('one label collapses and comes back on its own', async ({ page }) => {
  await open(page);
  await page.evaluate(() => localStorage.removeItem('c4studio.labelOverrides'));
  await page.reload();
  const labels = page.getByTestId('c4-edge-label');
  // Counted once the diagram has drawn them; straight after the reload there may be none yet.
  await expect(labels.first()).toBeVisible();
  const total = await labels.count();
  const wrap = page.locator('.c4-edge-label-wrap').first();
  await wrap.hover();
  await wrap.getByRole('button', { name: /Collapse label/ }).click();
  await expect(labels).toHaveCount(total - 1);
  await expect(page.getByTestId('c4-edge-dot')).toHaveCount(1);
  await page.getByTestId('c4-edge-dot').click();
  await expect(labels).toHaveCount(total);
});

// The chat tests mock every chat endpoint, so they need no provider key and write nothing to disk.
// The mock holds chats as the server does: each prompt is saved to its chat with the answer.
async function mockChat(page: Page) {
  const messages = Array.from({ length: 15 }, (_, i) => [
    { id: `u${i}`, role: 'user', parts: [{ type: 'text', text: `Question ${i + 1} about the bank?` }] },
    { id: `a${i}`, role: 'assistant', parts: [{ type: 'text', text: `Answer ${i + 1}. ${'The banking system holds accounts and payments. '.repeat(6)}` }] },
  ]).flat();
  const answer = [
    { type: 'start' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: `A new answer. ${'The API reads from and writes to the database. '.repeat(30)}` },
    { type: 'text-end', id: 't' },
    { type: 'finish' },
  ];
  const models = ['test/model', 'test/other'];
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 30, 10, minutes)).toISOString();
  const chats = new Map<string, { title: string; updatedAt: string; messages: unknown[] }>([
    ['chat-bank-1', { title: 'Question 1 about the bank?', updatedAt: at(30), messages }],
    ['chat-older-2', { title: 'An older chat about queues', updatedAt: at(0), messages: [messages[0], { id: 'q', role: 'assistant', parts: [{ type: 'text', text: 'Queues decouple the services.' }] }] }],
  ]);
  const sent: { chatId: string; message: unknown; messages?: unknown }[] = [];
  await page.route('**/api/chat/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/chat/providers') return route.fulfill({ json: [{ id: 'openrouter', label: 'OpenRouter', available: true, defaultModel: models[0], suggestedModels: models }] });
    if (pathname.startsWith('/api/chat/providers/')) return route.fulfill({ json: { provider: 'openrouter', models, source: 'live' } });
    const chat = pathname.match(/^\/api\/chat\/chats\/[^/]+(?:\/([^/]+))?$/);
    if (chat && !chat[1]) {
      const list = [...chats].map(([id, c]) => ({ id, title: c.title, createdAt: c.updatedAt, updatedAt: c.updatedAt, messageCount: c.messages.length }));
      return route.fulfill({ json: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
    }
    if (chat) {
      const c = chats.get(chat[1]!);
      return c ? route.fulfill({ json: { id: chat[1], createdAt: c.updatedAt, ...c } }) : route.fulfill({ status: 404, json: { error: 'chat not found' } });
    }
    if (pathname.startsWith('/api/chat/runs/')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/chat', (route) => {
    const body = route.request().postDataJSON() as (typeof sent)[number];
    sent.push(body);
    const text = (body.message as { parts: { text: string }[] }).parts[0]!.text;
    const prev = chats.get(body.chatId);
    chats.set(body.chatId, { title: prev?.title ?? text, updatedAt: new Date().toISOString(), messages: [...(prev?.messages ?? []), body.message, { id: `a-${sent.length}`, role: 'assistant', parts: [{ type: 'text', text: 'A new answer.' }] }] });
    return route.fulfill({
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: `${answer.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
    });
  });
  return { sent };
}

test('the chat stays open across a reload, and maximised it is a modal overlay that Escape restores', async ({ page }) => {
  await mockChat(page);
  await open(page);
  const chat = page.getByRole('complementary', { name: 'Chat' });
  const main = page.locator('main');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(chat).toBeVisible();
  await page.reload();
  await expect(chat).toBeVisible();

  await page.getByRole('button', { name: 'Maximise the chat' }).click();
  await expect(page.getByRole('dialog', { name: 'Chat' })).toBeVisible();
  await expect(main).toHaveJSProperty('inert', true);
  await page.keyboard.press('Escape');
  await expect(chat).toBeVisible();
  await expect(main).toHaveJSProperty('inert', false);
  // Closing the expanded chat goes back to the side panel.
  await page.getByRole('button', { name: 'Maximise the chat' }).click();
  await page.getByRole('button', { name: 'Close the expanded chat' }).click();
  await expect(chat).toBeVisible();
  await expect(main).toHaveJSProperty('inert', false);

  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(chat).toBeHidden();
});

test("the chat log keeps the reader's place while they type, and follows a new answer from the end", async ({ page }) => {
  await mockChat(page);
  await open(page);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const log = page.getByRole('log', { name: 'Chat with the modelling assistant' });
  const gap = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const top = () => log.evaluate((el) => el.scrollTop);
  await expect(log.getByText('Answer 15.')).toBeVisible();
  await expect.poll(gap).toBeLessThan(2);

  await log.evaluate((el) => el.scrollTo({ top: 600, behavior: 'instant' }));
  await expect.poll(top).toBe(600);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await box.pressSequentially('What talks to the database?');
  await box.press('Shift+Enter');
  await box.pressSequentially('And why?');
  await page.getByLabel('Model', { exact: true }).selectOption('test/other');
  expect(await top()).toBe(600);

  await box.press('Enter');
  await expect(log.getByText('A new answer.')).toBeVisible();
  await expect.poll(gap).toBeLessThan(2);
});

test('New chat keeps the earlier chat, and the chat list opens it again', async ({ page }) => {
  const { sent } = await mockChat(page);
  await open(page);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const log = page.getByRole('log', { name: 'Chat with the modelling assistant' });
  await expect(log.getByText('Answer 15.')).toBeVisible();

  await page.getByRole('button', { name: 'Start a new chat' }).click();
  await expect(log.getByText('Answer 15.')).toBeHidden();
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('What does the gateway do?');
  await box.press('Enter');
  await expect(log.getByText('A new answer.')).toBeVisible();
  // Only the new prompt goes up; the server holds the rest of the chat.
  expect(sent).toHaveLength(1);
  expect(sent[0]!.chatId).not.toBe('chat-bank-1');
  expect(sent[0]!.messages).toBeUndefined();
  expect(sent[0]!.message).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'What does the gateway do?' }] });

  // A reload opens the chat that was open.
  await page.reload();
  await expect(log.getByText('A new answer.')).toBeVisible();
  await expect(log.getByText('Answer 15.')).toBeHidden();

  await page.getByRole('button', { name: 'Earlier chats' }).click();
  const list = page.getByRole('region', { name: 'Chats on this model' });
  await expect(list.getByRole('button')).toHaveText([/What does the gateway do\?Open/, /Question 1 about the bank\?/, /An older chat about queues/]);
  await expect(log).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(log).toBeVisible();

  await page.getByRole('button', { name: 'Earlier chats' }).click();
  await list.getByRole('button', { name: /Question 1 about the bank/ }).click();
  await expect(list).toBeHidden();
  await expect(log.getByText('Answer 15.')).toBeVisible();
  await expect(log.getByText('What does the gateway do?')).toBeHidden();
});

test('the inspector and chat panel widths drag, keep across a reload, and reset on double-click', async ({ page }) => {
  await mockChat(page);
  await open(page);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const chat = page.getByRole('complementary', { name: 'Chat' });
  const aside = page.getByRole('complementary', { name: 'Inspector' });
  const width = async (l: Locator) => Math.round((await l.boundingBox())!.width);
  const drag = async (name: string, dx: number) => {
    const b = (await page.getByRole('separator', { name }).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  const [asideBefore, chatBefore] = [await width(aside), await width(chat)];

  await drag('Resize the inspector', 100);
  await drag('Resize the chat panel', -100);
  expect(await width(aside)).toBe(asideBefore + 100);
  expect(await width(chat)).toBe(chatBefore + 100);
  await page.reload();
  expect(await width(aside)).toBe(asideBefore + 100);
  expect(await width(chat)).toBe(chatBefore + 100);

  const handle = page.getByRole('separator', { name: 'Resize the chat panel' });
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(chatBefore + 116));
  await page.keyboard.press('Home');
  expect(await width(chat)).toBe(320);
  await handle.dblclick();
  expect(await width(chat)).toBe(chatBefore);
});

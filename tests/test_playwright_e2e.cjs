'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const roots = [
      ...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean),
      ...process.env.PATH.split(path.delimiter)
        .filter(entry => path.basename(entry) === '.bin')
        .map(entry => path.dirname(entry)),
    ];
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
    roots.push(
      path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules'),
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
    );
    for (const root of roots) {
      try {
        return require(path.join(root, 'playwright'));
      } catch (fallbackError) {
        if (fallbackError.code !== 'MODULE_NOT_FOUND') throw fallbackError;
      }
    }
    throw error;
  }
}

const { chromium } = loadPlaywright();
const root = path.resolve(__dirname, '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function eventually(check, description) {
  const deadline = Date.now() + 10000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(description);
}

async function openPage(browser, url, badge) {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  try {
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.protocol === 'file:' ||
          (requestUrl.protocol === 'http:' && requestUrl.hostname === '127.0.0.1')) {
        await route.continue();
      } else {
        await route.abort();
      }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(url);
    await eventually(async () => (await page.locator('#runtime-badge').innerText()).trim() === badge,
      `Expected runtime badge ${badge}`);
    return { context, page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function actionIn(container, name, fallbackSelector) {
  const named = container.getByRole('button', { name });
  if (await named.count() === 1) return named;
  return container.locator(fallbackSelector).filter({ visible: true });
}

async function applyWealth(page) {
  const direct = page.locator('[data-preset="wealth"], button#preset-wealth').filter({ visible: true });
  if (await direct.count() === 1) {
    await direct.click();
    return;
  }
  const select = page.locator('select').filter({
    has: page.locator('option[value="wealth"]'),
    visible: true,
  });
  await select.selectOption('wealth');
  await (await actionIn(page, /프리셋 적용|적용하기|^적용$/, '#btn-apply-preset')).click();
}

async function confirm(page, name, required = true) {
  const dialog = page.locator('dialog#confirm-dialog');
  if (required) {
    await dialog.waitFor({ state: 'visible' });
  } else if (!await dialog.isVisible()) {
    return;
  }
  assert.equal(await dialog.evaluate(element => element.open), true);
  await (await actionIn(dialog, name, 'button[type="submit"], button[value="confirm"]')).click();
}

async function offline(browser, savePath) {
  const html = path.join(root, 'dist', 'JianghuChroniclesSaveEditor-v1.0.1.html');
  const { context, page, errors } = await openPage(browser, pathToFileURL(html).href, '브라우저 오프라인');
  try {
    const tabs = page.locator('[role="tab"]');
    assert.equal(await tabs.count(), 6);
    await page.locator('#btn-demo').click();

    const school = page.getByRole('tab', { name: /요약|문파|학교/ });
    const students = page.getByRole('tab', { name: /제자|학생|문하/ });
    await school.click();
    assert.equal(await school.getAttribute('aria-selected'), 'true');
    const schoolPanel = page.locator('[role="tabpanel"]:visible');
    assert.ok((await schoolPanel.innerText()).trim(), 'Expected school content');
    await school.press('ArrowRight');
    const nextTabIndex = await tabs.evaluateAll(elements => elements.indexOf(document.activeElement));
    const schoolIndex = await school.evaluate(element =>
      Array.from(document.querySelectorAll('[role="tab"]')).indexOf(element));
    assert.equal(nextTabIndex, (schoolIndex + 1) % 6, 'ArrowRight must focus the next tab');

    await students.click();
    assert.equal(await students.getAttribute('aria-selected'), 'true');
    const studentPanel = page.locator('[role="tabpanel"]:visible');
    assert.ok((await studentPanel.innerText()).trim(), 'Expected student content');
    await eventually(async () => await studentPanel.locator(
      'tbody tr:has(td:nth-child(2)), [data-student-id], article'
    ).count() > 0, 'Expected rendered demo student records');

    const presetTab = page.getByRole('tab', { name: /프리셋|일괄/ });
    if (await presetTab.count() === 1) await presetTab.click();
    else await school.click();
    const diff = page.locator('#diff-rows');
    const previous = await diff.textContent();
    await applyWealth(page);
    await eventually(async () => {
      const updated = (await diff.textContent()).trim();
      return updated.length > 0 && updated !== previous.trim();
    }, 'Expected the wealth preset to update the diff');

    await page.locator('#btn-validate').click();
    await page.locator('#btn-save').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      confirm(page, /확인|다운로드|저장/),
    ]);
    assert.match(download.suggestedFilename(), /\.sav$/i);
    await download.saveAs(savePath);
    assert.ok((await fs.stat(savePath)).size > 0);
    assert.doesNotMatch(await page.locator('body').innerText(),
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

function startServer(directory) {
  const child = spawn('python3', ['-u', 'jhl_editor.py', 'serve', '--dir', directory], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stopped = new Promise(resolve => child.once('close', resolve));
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timed out\n${output}`)), 15000);
    function receive(chunk) {
      output += chunk.toString();
      const address = output.match(/http:\/\/127\.0\.0\.1:(\d+)(?:\/|\s|$)/);
      if (address) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${address[1]}/`);
      }
    }
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code})\n${output}`));
    });
  });
  return {
    ready,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3000);
      try {
        await stopped;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function serverMode(browser, directory, savePath) {
  const originalHash = sha256(await fs.readFile(savePath));
  const server = startServer(directory);
  try {
    const { context, page } = await openPage(browser, await server.ready, '서버 연결됨');
    try {
      await page.locator('#btn-discover').click();
      const filename = path.basename(savePath);
      const saveButton = page.getByRole('button', { name: filename, exact: true });
      const loadButton = page.getByRole('button', { name: /불러오기|열기/ });
      const discoveredName = page.getByText(filename, { exact: true });
      await discoveredName.first().waitFor({ state: 'visible' });
      if (await saveButton.count() === 1) {
        await saveButton.click();
      } else {
        const row = page.getByRole('row').filter({ has: discoveredName });
        if (await row.getByRole('button', { name: /불러오기|열기/ }).count() === 1) {
          await row.getByRole('button', { name: /불러오기|열기/ }).click();
        } else {
          await discoveredName.first().click();
          if (await loadButton.count() === 1 && await loadButton.isVisible()) await loadButton.click();
        }
      }

      const school = page.getByRole('tab', { name: /요약|문파|학교/ });
      await school.click();
      const money = page.locator(
        'input#money, input[name="money"], input[data-field="money"], input[data-key="money"], input[id$="-money"]'
      ).filter({ visible: true });
      await money.waitFor({ state: 'visible' });
      const initialMoney = Number(await money.inputValue());
      assert.ok(Number.isSafeInteger(initialMoney));
      const max = await money.getAttribute('max');
      const nextMoney = max !== null && initialMoney >= Number(max) ? initialMoney - 1 : initialMoney + 1;
      await money.fill(String(nextMoney));
      await money.press('Tab');

      await page.locator('#btn-save').click();
      await confirm(page, /확인|저장/);
      await eventually(async () => sha256(await fs.readFile(savePath)) !== originalHash,
        'Expected a changed on-disk SHA-256 after saving');

      const backupDirectory = path.join(directory, '.jhl_backups');
      let backupName;
      await eventually(async () => {
        const entries = await fs.readdir(backupDirectory, { withFileTypes: true }).catch(error => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        const backups = entries.filter(entry => entry.isFile() && /\.bak\./.test(entry.name));
        assert.ok(backups.length <= 1, 'Expected one backup for one save');
        backupName = backups[0]?.name;
        return Boolean(backupName);
      }, 'Expected an on-disk .jhl_backups/*.bak.* file');
      assert.equal(sha256(await fs.readFile(path.join(backupDirectory, backupName))), originalHash);

      await page.locator('#btn-backups').click();
      await page.getByRole('button', { name: /복원/ }).click();
      await eventually(async () => {
        if (sha256(await fs.readFile(savePath)) === originalHash) return true;
        if (await page.locator('dialog#confirm-dialog').isVisible()) {
          await confirm(page, /확인|복원/);
        }
        return false;
      }, 'Expected restoring the backup to recover the original SHA-256');
    } finally {
      await context.close();
    }
  } finally {
    await server.stop();
  }
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jhl-playwright-'));
  let browser;
  try {
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const savePath = path.join(directory, 'synthetic-demo.sav');
    await offline(browser, savePath);
    await serverMode(browser, directory, savePath);
    console.log('Playwright offline and server cases passed.');
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

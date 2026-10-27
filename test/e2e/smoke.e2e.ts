import { browser, expect } from '@wdio/globals';
import data from '../../tests/vectors/daylio-backup-import.json';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type DaylioBackupImportPlugin from '../../src/main';
import type { SponsorsManager } from '../../src/license/index';
import { pluginId, reloadPlugin } from './load';

const fixture = Array.from(readFileSync('tests/fixtures/daylio-v15.daylio'));
const photo = Array.from(readFileSync('tests/fixtures/photo.png'));
const vectors = data as unknown as { cases: { name: string; function: string; args: unknown[]; expected: unknown }[] };
type Host = { plugins: { plugins: Record<string, DaylioBackupImportPlugin> } };

async function closeModals(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		(app as unknown as Host).plugins.plugins['daylio-backup-import']!.closeImportWindows();
	});
}
async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, enabled) => {
		const p = (app as unknown as Host).plugins.plugins['daylio-backup-import']!;
		const pro = p.pro as SponsorsManager;
		if (!enabled) { pro.signOut(); return; }
		// Synthetic token store and HTTP answer. No network request or Keychain key.
		let token: string | null = 'gho_' + '0'.repeat(36);
		pro.opts.tokens.get = () => token; pro.opts.tokens.set = (v) => { token = v; }; pro.opts.tokens.clear = () => { token = null; };
		pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader', totalSponsorshipAmountAsSponsorInCents: 1500 }, user: { viewerIsSponsoring: true, sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		await pro.refreshNow();
	}, on);
}
function archive(json: string): number[] {
	return Array.from(zipSync({ 'backup.daylio': strToU8(Buffer.from(json, 'utf8').toString('base64')) }));
}

describe('Daylio Backup Import in real Obsidian', function () {
	afterEach(async () => { await closeModals(); await setPro(false); });

	it('loads and reloads with no errors', async () => {
		expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('runs the payload golden vectors with the app atob and TextDecoder', async () => {
		for (const c of vectors.cases.filter((v) => v.function === 'inspectPayload')) {
			const result = await browser.executeObsidian(({ app }, bytes) => {
				const p = (app as unknown as Host).plugins.plugins['daylio-backup-import']!;
				try {
					const b = p.readBackup(new Uint8Array(bytes));
					return JSON.stringify({ version: b.version, entries: b.entries, assets: b.assets, warnings: b.warnings });
				} catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
			}, archive(c.args[0] as string));
			expect(JSON.parse(result)).toEqual(c.expected);
		}
	});

	it('selects the backup in the UI and creates two notes and one photo', async () => {
		await browser.executeObsidian(({ app }) => { (app as unknown as Host).plugins.plugins['daylio-backup-import']!.settings.folder = 'E2E journal'; });
		await browser.executeObsidianCommand(`${pluginId}:import-backup`);
		await browser.$('input[type="file"]').setValue(resolve('tests/fixtures/daylio-v15.daylio'));
		await browser.waitUntil(async () => (await browser.$('.daylio-status').getText()).includes('Preview ready'), { timeout: 20000, timeoutMsg: 'Import preview did not finish' });
		expect(await browser.$('.daylio-counts').getText()).toContain('2 entries');
		// Free users can select Save rules: the select shows the Pro notice (test/e2e/pro-notice.e2e.ts).
		expect(await browser.$('button=Save rules (Pro)').isEnabled()).toBe(true);
		await browser.$('button=Create notes').click();
		await browser.waitUntil(async () => (await browser.$('.daylio-status').getText()).includes('2 notes created'), { timeout: 20000, timeoutMsg: 'Import did not finish' });
		const output = await browser.executeObsidian(async ({ app }) => {
			const a = app.vault.getFileByPath('E2E journal/2023-11-19 Daylio 15024.md')!;
			const b = app.vault.getFileByPath('E2E journal/2023-11-19 Daylio 15025.md')!;
			const img = app.vault.getFileByPath('E2E journal/attachments/daylio-a3f1c0de5b7e4c2d9e8f.png')!;
			return { a: await app.vault.read(a), b: await app.vault.read(b), photo: Array.from(new Uint8Array(await app.vault.readBinary(img))) };
		});
		expect(output.a).toContain('daylio_local_time: 2023-11-19 10:45:59.432');
		expect(output.a).toContain('**world**');
		expect(output.a).toContain('long walk');
		expect(output.a).toContain('![[E2E journal/attachments/daylio-a3f1c0de5b7e4c2d9e8f.png]]');
		expect(output.b).toContain('mood: calm');
		expect(output.b).toContain('第二条 😀');
		expect(output.photo).toEqual(photo);
	});

	it('skips both IDs on a second run', async () => {
		const result = await browser.executeObsidian(async ({ app }, bytes) => {
			const p = (app as unknown as Host).plugins.plugins['daylio-backup-import']!;
			const options = { folder: 'E2E repeat journal', nameRule: '{date} Daylio {id}', filter: null, daily: null };
			const backup = p.readBackup(new Uint8Array(bytes));
			await p.importPlan(await p.prepare(backup, options));
			const file = app.vault.getFileByPath('E2E repeat journal/2023-11-19 Daylio 15024.md')!;
			const before = `${await app.vault.read(file)}\nMy edit.\n`;
			await app.vault.modify(file, before);
			const count = app.vault.getFiles().length;
			const next = await p.importPlan(await p.prepare(backup, options));
			return { next, before, after: await app.vault.read(file), count, nextCount: app.vault.getFiles().length };
		}, fixture);
		expect(result.next).toMatchObject({ created: 0, skipped: 2, photos: 0 });
		expect(result.after).toBe(result.before);
		expect(result.nextCount).toBe(result.count);
	});

	it('shows the reason for a version 16 backup and creates nothing', async () => {
		const before = await browser.executeObsidian(({ app }) => app.vault.getFiles().map((file) => file.path).sort());
		await browser.executeObsidianCommand(`${pluginId}:import-backup`);
		await browser.$('input[type="file"]').setValue(resolve('tests/fixtures/version-16.daylio'));
		await browser.waitUntil(async () => (await browser.$('.daylio-status').getText()).includes('version 16'), { timeout: 20000 });
		expect(await browser.$('button=Create notes').isEnabled()).toBe(false);
		expect(await browser.executeObsidian(({ app }) => app.vault.getFiles().map((file) => file.path).sort())).toEqual(before);
	});

	it('merges entries into a daily note section with Pro, and blocks it after sign out', async () => {
		await setPro(true);
		const result = await browser.executeObsidian(async ({ app }, bytes) => {
			const p = (app as unknown as Host).plugins.plugins['daylio-backup-import']!;
			const options = { folder: 'E2E pro journal', nameRule: '{date} {mood} {id}', filter: { from: '2023-11-19', to: '2023-11-19' }, daily: { folder: 'E2E daily', heading: 'Daylio' } };
			const plan = await p.prepare(p.readBackup(new Uint8Array(bytes)), options);
			const first = await p.importPlan(plan);
			const second = await p.importPlan(await p.prepare(p.readBackup(new Uint8Array(bytes)), options));
			const daily = await app.vault.read(app.vault.getFileByPath('E2E daily/2023-11-19.md')!);
			p.pro!.signOut();
			let blocked = '';
			try { await p.importPlan(plan); } catch (e) { blocked = e instanceof Error ? e.message : String(e); }
			return { first, second, daily, blocked };
		}, fixture);
		expect(result.first).toMatchObject({ created: 2, merged: 2 });
		expect(result.second).toMatchObject({ created: 0, merged: 0 });
		expect(result.daily).toContain('## Daylio');
		expect(result.daily).toContain('^daylio-15024');
		expect(result.daily).toContain('[[E2E pro journal/2023-11-19 calm 15025|Daylio 15025]]');
		expect(result.blocked).toContain('need Pro');
	});
});

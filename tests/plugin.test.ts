import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian-test-mocks/obsidian';
import DaylioBackupImportPlugin, { NEED_PRO } from '../src/main';
import { readBackup } from '../src/backup';
import { BATCH, writeImport } from '../src/importer';
import { DEFAULT_NAME_RULE } from '../src/model';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { ImportModal } from '../src/modal';
import { bindPro, resetPro, SPONSORS } from '../src/pro';
import { PHOTO, buildBackup, payload } from './fixture';
import manifest from '../manifest.json';

const fixture = () => readBackup(new Uint8Array(readFileSync('tests/fixtures/daylio-v15.daylio')));
const free = { folder: 'Journal', nameRule: DEFAULT_NAME_RULE, filter: null, daily: null };
function setup(files: Record<string, string> = {}) {
	const app = App.createConfigured__({ files });
	const plugin = new DaylioBackupImportPlugin(app as never, manifest as never);
	return { app, plugin };
}
function pro(value: boolean) { bindPro({ isPro: () => value, onChange: () => () => undefined } as never); }
async function read(app: ReturnType<typeof setup>['app'], path: string): Promise<string> {
	return app.vault.read(app.vault.getAbstractFileByPath(path) as TFile);
}
afterEach(() => resetPro());

describe('vault import', () => {
	it('loads and repairs saved settings', async () => {
		const { plugin } = setup();
		await plugin.loadSettings();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ folder: '../x', nameRule: '{date}', filter: { from: 'bad' }, dailyHeading: 'a#b' })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
	it('case 1 and 2: creates two notes keyed by ID and one photo in an empty folder', async () => {
		const { app, plugin } = setup();
		const plan = await plugin.prepare(fixture(), free);
		expect(app.vault.getFiles()).toHaveLength(0);
		const result = await plugin.importPlan(plan);
		expect(result).toEqual({ created: 2, skipped: 0, photos: 1, merged: 0, errors: [], cancelled: false });
		const a = await read(app, 'Journal/2023-11-19 Daylio 15024.md');
		const b = await read(app, 'Journal/2023-11-19 Daylio 15025.md');
		expect(a).toContain('daylio_id: 15024');
		expect(a).toContain('mood: rad');
		expect(a).toContain('long walk');
		expect(a).toContain('**world**');
		expect(a).toContain('![[Journal/attachments/daylio-a3f1c0de5b7e4c2d9e8f.png]]');
		expect(b).toContain('daylio_id: 15025');
		expect(b).toContain('mood: calm');
		expect(b).toContain('第二条 😀');
		const photo = app.vault.getAbstractFileByPath('Journal/attachments/daylio-a3f1c0de5b7e4c2d9e8f.png') as TFile;
		expect(new Uint8Array(await app.vault.readBinary(photo))).toEqual(PHOTO);
	});
	it('case 6: a missing photo keeps both bodies and makes no image embed', async () => {
		const { app, plugin } = setup();
		const backup = readBackup(new Uint8Array(readFileSync('tests/fixtures/no-photo.daylio')));
		expect(backup.missing).toHaveLength(1);
		const result = await plugin.importPlan(await plugin.prepare(backup, free));
		expect(result.created).toBe(2);
		expect(result.photos).toBe(0);
		const a = await read(app, 'Journal/2023-11-19 Daylio 15024.md');
		expect(a).toContain('**world**');
		expect(a).not.toContain('![[');
		expect(await read(app, 'Journal/2023-11-19 Daylio 15025.md')).toContain('第二条 😀');
	});
	it('case 7: a second run skips two IDs, copies no photo and changes no note', async () => {
		const { app, plugin } = setup();
		await plugin.importPlan(await plugin.prepare(fixture(), free));
		const path = 'Journal/2023-11-19 Daylio 15024.md';
		const file = app.vault.getAbstractFileByPath(path) as TFile;
		await app.vault.modify(file, `${await app.vault.read(file)}\nMy edit.`);
		const before = app.vault.getFiles().length;
		const next = await plugin.prepare(fixture(), free);
		expect(next.entries.filter((e) => e.existing)).toHaveLength(2);
		const result = await plugin.importPlan(next);
		expect(result).toMatchObject({ created: 0, skipped: 2, photos: 0 });
		expect(app.vault.getFiles()).toHaveLength(before);
		expect(await read(app, path)).toContain('My edit.');
	});
	it('case 8: version 16 and ../outside.md fail before any vault write', () => {
		const { app } = setup();
		expect(() => readBackup(new Uint8Array(readFileSync('tests/fixtures/version-16.daylio')))).toThrow('version 16');
		expect(() => readBackup(buildBackup(payload(), { '../outside.md': new Uint8Array([1]) }))).toThrow('unsafe');
		expect(app.vault.getFiles()).toHaveLength(0);
	});
	it('a different note at the target path is kept and reported', async () => {
		const { app, plugin } = setup({ 'Journal/2023-11-19 Daylio 15024.md': 'Keep me' });
		const plan = await plugin.prepare(fixture(), free);
		expect(plan.entries[0]?.conflict).toContain('different note');
		const result = await plugin.importPlan(plan);
		expect(result).toMatchObject({ created: 1, skipped: 1 });
		expect(await read(app, 'Journal/2023-11-19 Daylio 15024.md')).toBe('Keep me');
	});
	it('a different photo at the photo path skips the entry', async () => {
		const { app, plugin } = setup();
		await app.vault.createFolder('Journal');
		await app.vault.createFolder('Journal/attachments');
		await app.vault.createBinary('Journal/attachments/daylio-a3f1c0de5b7e4c2d9e8f.png', new Uint8Array([1, 2]).buffer);
		const result = await plugin.importPlan(await plugin.prepare(fixture(), free));
		expect(result).toMatchObject({ created: 1, skipped: 1, photos: 0 });
	});
	it('rejects duplicate output identities before writes', async () => {
		const { app, plugin } = setup();
		const backup = fixture();
		backup.entries = [backup.entries[0]!, { ...backup.entries[0]! }];
		await expect(plugin.prepare(backup, free)).rejects.toThrow('same output path');
		expect(app.vault.getFiles()).toHaveLength(0);
	});
	it('stops between batches on cancel and reports partial writes', async () => {
		const { app } = setup();
		const data = payload();
		const one = (data.dayEntries as Record<string, unknown>[])[1]!;
		data.dayEntries = Array.from({ length: BATCH * 3 }, (_, i) => ({ ...one, id: i + 1 }));
		const backup = readBackup(buildBackup(data, {}, false));
		const { prepareImport } = await import('../src/importer');
		const plan = await prepareImport(app.vault as never, backup, free);
		const token = { cancelled: false };
		const create = app.vault.create.bind(app.vault);
		let count = 0;
		vi.spyOn(app.vault, 'create').mockImplementation(async (...args: Parameters<typeof create>) => { if (++count === BATCH) token.cancelled = true; return create(...args); });
		const result = await writeImport(app.vault as never, plan, token);
		expect(result).toMatchObject({ created: BATCH, cancelled: true });
	});
	it('a write error is reported and other entries continue', async () => {
		const { app, plugin } = setup();
		const plan = await plugin.prepare(fixture(), free);
		vi.spyOn(app.vault, 'create').mockRejectedValueOnce(new Error('Disk full'));
		const result = await plugin.importPlan(plan);
		expect(result.errors[0]).toContain('Disk full');
		expect(result.created).toBe(1);
	});
});

describe('Pro access', () => {
	it('free options ignore saved Pro rules', () => {
		const { plugin } = setup();
		plugin.settings = { ...plugin.settings, useRules: true, nameRule: '{id}', filter: { from: '2024-01-01', to: '' }, dailyMerge: true };
		expect(plugin.options('Journal')).toEqual(free);
	});
	it('Pro options are blocked without Pro at preview and at write', async () => {
		const { plugin } = setup();
		await expect(plugin.prepare(fixture(), { ...free, nameRule: '{id}' })).rejects.toThrow(NEED_PRO);
		pro(true);
		const plan = await plugin.prepare(fixture(), { ...free, daily: { folder: 'Daily', heading: 'Daylio' } });
		pro(false);
		await expect(plugin.importPlan(plan)).rejects.toThrow(NEED_PRO);
		expect(await plugin.saveRules({ ...DEFAULT_SETTINGS })).toBe(false);
	});
	it('Pro merges entries into the named daily note section once', async () => {
		pro(true);
		const { app, plugin } = setup({ 'Daily/2023-11-19.md': '# Sunday\n\nText.\n\n## Daylio\n\n## Tasks\n\n- [ ] call\n' });
		const options = { ...free, daily: { folder: 'Daily', heading: 'Daylio' } };
		const result = await plugin.importPlan(await plugin.prepare(fixture(), options));
		expect(result.merged).toBe(2);
		const text = await read(app, 'Daily/2023-11-19.md');
		expect(text).toBe('# Sunday\n\nText.\n\n## Daylio\n\n- 10:45 · rad · long walk [[Journal/2023-11-19 Daylio 15024|Daylio 15024]] ^daylio-15024\n- 10:45 · calm · reading [[Journal/2023-11-19 Daylio 15025|Daylio 15025]] ^daylio-15025\n\n## Tasks\n\n- [ ] call\n');
		const again = await plugin.importPlan(await plugin.prepare(fixture(), options));
		expect(again).toMatchObject({ created: 0, skipped: 2, merged: 0 });
		expect(await read(app, 'Daily/2023-11-19.md')).toBe(text);
	});
	it('Pro creates a missing daily note', async () => {
		pro(true);
		const { app, plugin } = setup();
		await plugin.importPlan(await plugin.prepare(fixture(), { ...free, daily: { folder: 'Daily', heading: 'Mood log' } }));
		expect(await read(app, 'Daily/2023-11-19.md')).toContain('## Mood log\n\n- 10:45 · rad');
	});
	it('Pro date filter and file name rule apply and save', async () => {
		pro(true);
		const { app, plugin } = setup();
		const plan = await plugin.prepare(fixture(), { ...free, nameRule: '{date} {mood} {id}', filter: { from: '2023-11-20', to: '' } });
		expect(plan.entries).toHaveLength(0);
		expect(plan.filtered).toBe(2);
		const kept = await plugin.prepare(fixture(), { ...free, nameRule: '{date} {mood} {id}', filter: { from: '2023-11-19', to: '2023-11-19' } });
		await plugin.importPlan(kept);
		expect(app.vault.getAbstractFileByPath('Journal/2023-11-19 calm 15025.md')).toBeInstanceOf(TFile);
		expect(await plugin.saveRules({ useRules: true, nameRule: '{date} {mood} {id}', filter: { from: '2023-11-19', to: '' }, dailyMerge: true, dailyFolder: 'Daily', dailyHeading: 'Daylio' })).toBe(true);
		expect(plugin.options('Journal')).toEqual({ folder: 'Journal', nameRule: '{date} {mood} {id}', filter: { from: '2023-11-19', to: '' }, daily: { folder: 'Daily', heading: 'Daylio' } });
		await expect(plugin.saveRules({ ...plugin.settings, nameRule: '{date}' })).rejects.toThrow('{id}');
	});
	it('Sponsors config matches the reference', () => {
		expect(SPONSORS).toMatchObject({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, oneTimeMonths: 0, scope: 'read:user' });
	});
});

describe('import window', () => {
	it('shows counts and creates notes from the buttons', async () => {
		const { app, plugin } = setup();
		// The mock Modal.open closes the modal on the next tick. Call onOpen to keep it open.
		const modal = new ImportModal(plugin, fixture());
		modal.onOpen();
		await vi.waitFor(() => { expect(modal.contentEl.querySelector('.daylio-counts')?.textContent).toContain('2 entries · 1 photos · 0 missing photos'); }, { timeout: 20000 });
		const create = Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Create notes');
		expect(create?.disabled).toBe(false);
		create!.click();
		await vi.waitFor(() => { expect(modal.contentEl.querySelector('.daylio-status')?.textContent).toContain('2 notes created'); }, { timeout: 20000 });
		expect(app.vault.getAbstractFileByPath('Daylio/2023-11-19 Daylio 15025.md')).toBeInstanceOf(TFile);
		const save = Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Save rules (Pro)');
		expect(save?.disabled).toBe(true);
		modal.close();
	});
	it('shows the reason when a backup is rejected', async () => {
		const { plugin } = setup();
		const modal = new ImportModal(plugin);
		modal.onOpen();
		const input = modal.contentEl.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File([readFileSync('tests/fixtures/version-16.daylio')], 'old.daylio');
		Object.defineProperty(input, 'files', { value: [file] });
		input.dispatchEvent(new Event('change'));
		await vi.waitFor(() => { expect(modal.contentEl.querySelector('.daylio-status')?.textContent).toContain('version 16'); }, { timeout: 20000 });
		const create = Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Create notes');
		expect(create?.disabled).toBe(true);
		modal.close();
	});
});

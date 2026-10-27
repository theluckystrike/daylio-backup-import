import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice, ToggleComponent } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import DaylioBackupImportPlugin, { NEED_PRO } from '../src/main';
import { readBackup } from '../src/backup';
import { ImportModal } from '../src/modal';
import { bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

// A free user can select the Pro controls of the import window. The select shows the shared Pro notice with the
// "Sponsor on GitHub" button. No rule is saved, no Pro option turns on, and each toggle shows off again.
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';
const fixture = () => readBackup(new Uint8Array(readFileSync('tests/fixtures/daylio-v15.daylio')));

function fakePro(pro: boolean): SponsorsManager {
	return {
		isPro: () => pro,
		onChange: () => () => undefined,
		hasToken: () => false,
		isChecking: () => false,
		getState: () => ({ status: 'unchecked', lastAttemptAt: 0 }),
		config: { sponsorLogin: 'theluckystrike', source: 'daylio-backup-import' },
	} as unknown as SponsorsManager;
}

const toggles: ToggleComponent[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(pro: boolean) {
	const app = App.createConfigured__({ files: {} });
	const plugin = new DaylioBackupImportPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	plugin.saveSettings = vi.fn(async () => undefined);
	bindPro(fakePro(pro));
	const shown: { text: string; buttons: number }[] = [];
	vi.spyOn(Notice.prototype as unknown as { constructor__(): void }, 'constructor__').mockImplementation(function (this: Notice) {
		shown.push({ text: this.messageEl.textContent ?? '', buttons: this.messageEl.querySelectorAll('.pf-pro-notice-sponsor').length });
	});
	vi.spyOn(ToggleComponent.prototype, 'constructor3__').mockImplementation(function (this: ToggleComponent) { toggles.push(this); });
	const modal = new ImportModal(plugin, fixture());
	modal.onOpen();
	await vi.waitFor(() => { expect(modal.contentEl.querySelector('.daylio-counts')?.textContent).toContain('2 entries'); }, { timeout: 20000 });
	return { plugin, modal, shown };
}

/** The drawn toggle of the setting row with this name. Each updatePro() draws new rows, so look it up after each draw. */
function toggle(modal: ImportModal, name: string): ToggleComponent {
	const t = toggles.find((c) => modal.contentEl.contains(c.toggleEl) && c.toggleEl.closest('.setting-item')?.querySelector('.setting-item-name')?.textContent === name);
	if (!t) throw new Error(`No toggle in the row "${name}".`);
	return t;
}
const isOn = (t: ToggleComponent) => t.getValue() && t.toggleEl.classList.contains('is-enabled');
const saveButton = (modal: ImportModal) => [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Save rules (Pro)')!;

describe('Pro controls of the import window', () => {
	afterEach(() => { resetPro(); vi.restoreAllMocks(); toggles.length = 0; });

	it('a free user who selects a Pro toggle or Save rules gets the Pro notice with a Sponsor button, and nothing changes or saves', async () => {
		const { plugin, modal, shown } = await setup(false);
		const saveRules = vi.spyOn(plugin, 'saveRules');
		const counts = modal.contentEl.querySelector('.daylio-counts')?.textContent;
		const before = JSON.stringify(plugin.settings);
		for (const name of ['Use the rules below', 'Merge entries into daily notes']) {
			const t = toggle(modal, name);
			expect(isOn(t)).toBe(false);
			expect(t.disabled).toBe(false);
			t.onClick();
			// The toggle shows its true state: off.
			expect(isOn(toggle(modal, name))).toBe(false);
		}
		const save = saveButton(modal);
		expect(save.disabled).toBe(false);
		save.click(); await flush();
		expect(shown).toEqual([
			{ text: `${NEED_PRO} ${PITCH}Sponsor on GitHub`, buttons: 1 },
			{ text: `${NEED_PRO} ${PITCH}Sponsor on GitHub`, buttons: 1 },
			{ text: `${NEED_PRO} ${PITCH}Sponsor on GitHub`, buttons: 1 },
		]);
		expect(saveRules).not.toHaveBeenCalled();
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(JSON.stringify(plugin.settings)).toBe(before);
		// No Pro option is on, and the preview and the Create button stay.
		expect(modal.options()).toEqual({ folder: 'Daylio', nameRule: plugin.settings.nameRule, filter: null, daily: null });
		expect(modal.contentEl.querySelector('.daylio-counts')?.textContent).toBe(counts);
		expect([...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Create notes')?.disabled).toBe(false);
		modal.close();
	});

	it('a Pro user who selects the Pro toggles and Save rules turns them on and saves the rules', async () => {
		const { plugin, modal, shown } = await setup(true);
		for (const name of ['Use the rules below', 'Merge entries into daily notes']) {
			toggle(modal, name).onClick();
			expect(isOn(toggle(modal, name))).toBe(true);
		}
		saveButton(modal).click();
		await vi.waitFor(() => { expect(plugin.saveSettings).toHaveBeenCalled(); });
		expect(plugin.settings.useRules).toBe(true);
		expect(plugin.settings.dailyMerge).toBe(true);
		expect(modal.options().daily).toEqual({ folder: plugin.settings.dailyFolder, heading: plugin.settings.dailyHeading });
		expect(shown.filter((n) => n.buttons > 0)).toEqual([]);
		modal.close();
	});
});

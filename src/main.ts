import { TEXT } from './copy';
import { Notice, Plugin } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { readBackup, type Backup } from './backup';
import { prepareImport, validateOptions, writeImport, type CancelToken, type ImportOptions, type ImportPlan, type ImportResult } from './importer';
import { DEFAULT_NAME_RULE } from './model';
import { ImportModal } from './modal';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DaylioBackupImportSettingTab, normalizeSettings, type DaylioBackupImportSettings } from './settings';

export const NEED_PRO = 'Date filters, file name rules and the daily note section need Pro. Sign in from the plugin settings.';

/** True when the options use a Pro feature. */
export function usesPro(options: ImportOptions): boolean {
	return options.nameRule !== DEFAULT_NAME_RULE || options.filter !== null || options.daily !== null;
}

export default class DaylioBackupImportPlugin extends Plugin {
	settings: DaylioBackupImportSettings = normalizeSettings(null);
	pro: SponsorsManager | null = null;
	private tab: DaylioBackupImportSettingTab | null = null;
	private modals = new Set<ImportModal>();
	private importing = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.tab = new DaylioBackupImportSettingTab(this.app, this);
		this.addSettingTab(this.tab);
		this.register(pro.onChange(() => { this.tab?.update(); for (const modal of this.modals) modal.updatePro(); }));
		this.addCommand({ id: 'import-backup', name: TEXT.title, callback: () => { this.openImport(); } });
		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}
	onunload(): void {
		this.closeImportWindows();
		resetPro();
	}
	closeImportWindows(): void {
		for (const modal of this.modals) modal.close();
		this.modals.clear();
	}
	openImport(backup?: Backup): ImportModal {
		this.closeImportWindows();
		const modal = new ImportModal(this, backup);
		this.modals.add(modal);
		modal.open();
		return modal;
	}
	closed(modal: ImportModal): void { this.modals.delete(modal); }
	readBackup(bytes: Uint8Array): Backup { return readBackup(bytes); }
	/** Options from the settings. Pro rules apply only when Pro is on. */
	options(folder = this.settings.folder): ImportOptions {
		const s = this.settings;
		const pro = isPro();
		const rules = pro && s.useRules;
		return {
			folder,
			nameRule: rules ? s.nameRule : DEFAULT_NAME_RULE,
			filter: rules && (s.filter.from || s.filter.to) ? { ...s.filter } : null,
			daily: pro && s.dailyMerge ? { folder: s.dailyFolder, heading: s.dailyHeading } : null,
		};
	}
	async prepare(backup: Backup, options: ImportOptions = this.options()): Promise<ImportPlan> {
		if (usesPro(options) && !isPro()) throw new Error(NEED_PRO);
		return prepareImport(this.app.vault, backup, options);
	}
	async importPlan(plan: ImportPlan, token?: CancelToken): Promise<ImportResult> {
		if (this.importing) throw new Error('An import is in progress.');
		// Check Pro again at write time. Pro can turn off after the preview.
		if (usesPro(plan.options) && !isPro()) throw new Error(NEED_PRO);
		this.importing = true;
		try { return await writeImport(this.app.vault, plan, token); } finally { this.importing = false; }
	}
	/** Save the date filter, file name rule and daily note section. Pro only. */
	async saveRules(rules: Pick<DaylioBackupImportSettings, 'useRules' | 'nameRule' | 'filter' | 'dailyMerge' | 'dailyFolder' | 'dailyHeading'>): Promise<boolean> {
		if (!isPro()) { new Notice(NEED_PRO); return false; }
		validateOptions({ folder: this.settings.folder, nameRule: rules.nameRule, filter: rules.filter, daily: { folder: rules.dailyFolder, heading: rules.dailyHeading } });
		this.settings = normalizeSettings({ ...this.settings, ...rules, filter: { ...rules.filter } });
		await this.saveSettings();
		return true;
	}
	async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData()); }
	async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

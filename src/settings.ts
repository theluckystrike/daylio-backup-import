import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { DEFAULT_NAME_RULE, safeFolder, validHeading, validateFilter, validateNameRule, type DateFilter } from './model';
import { PRO_UI } from './pro';
import type DaylioBackupImportPlugin from './main';

export interface DaylioBackupImportSettings {
	folder: string;
	/** Pro rules. The import uses them only when Pro is on and the rules toggle is on. */
	useRules: boolean;
	nameRule: string;
	filter: DateFilter;
	dailyMerge: boolean;
	dailyFolder: string;
	dailyHeading: string;
}

export const DEFAULT_SETTINGS: DaylioBackupImportSettings = {
	folder: 'Daylio',
	useRules: false,
	nameRule: DEFAULT_NAME_RULE,
	filter: { from: '', to: '' },
	dailyMerge: false,
	dailyFolder: 'Daily',
	dailyHeading: 'Daylio',
};

function valid<T>(value: unknown, check: (v: string) => T, fallback: T): T {
	if (typeof value !== 'string') return fallback;
	try { return check(value); } catch { return fallback; }
}

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: unknown): DaylioBackupImportSettings {
	const s = typeof saved === 'object' && saved !== null ? saved as Partial<Record<keyof DaylioBackupImportSettings, unknown>> : {};
	const f = typeof s.filter === 'object' && s.filter !== null ? s.filter as Partial<Record<keyof DateFilter, unknown>> : {};
	let filter: DateFilter = { from: typeof f.from === 'string' ? f.from : '', to: typeof f.to === 'string' ? f.to : '' };
	try { validateFilter(filter); } catch { filter = { ...DEFAULT_SETTINGS.filter }; }
	return {
		folder: valid(s.folder, safeFolder, DEFAULT_SETTINGS.folder),
		useRules: s.useRules === true,
		nameRule: valid(s.nameRule, (v) => { validateNameRule(v); return v; }, DEFAULT_SETTINGS.nameRule),
		filter,
		dailyMerge: s.dailyMerge === true,
		dailyFolder: valid(s.dailyFolder, safeFolder, DEFAULT_SETTINGS.dailyFolder),
		dailyHeading: valid(s.dailyHeading, validHeading, DEFAULT_SETTINGS.dailyHeading),
	};
}

export class DaylioBackupImportSettingTab extends PluginSettingTab {
	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], readonly plugin: DaylioBackupImportPlugin) { super(app, plugin); }
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Import folder', desc: 'Default folder for new notes and photos. You can change it in the import window.', control: { type: 'text', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder } },
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'folder' && typeof value === 'string') { try { safeFolder(value); } catch { return; } }
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
	}
}

import { TEXT } from './copy';
import { Modal, Notice, Setting } from 'obsidian';
import { MAX_COMPRESSED, type Backup } from './backup';
import type { CancelToken, ImportOptions, ImportPlan } from './importer';
import { DEFAULT_NAME_RULE } from './model';
import { NEED_PRO, isPro, proNotice, proText } from './pro';
import type DaylioBackupImportPlugin from './main';
import type { DaylioBackupImportSettings } from './settings';

type Rules = Pick<DaylioBackupImportSettings, 'useRules' | 'nameRule' | 'filter' | 'dailyMerge' | 'dailyFolder' | 'dailyHeading'>;

export class ImportModal extends Modal {
	private backup: Backup | null;
	private plan: ImportPlan | null = null;
	private folder: string;
	private rules: Rules;
	private busy = false;
	private generation = 0;
	private disposed = false;
	private token: CancelToken | null = null;
	private status: HTMLElement | null = null;
	private preview: HTMLElement | null = null;
	private proControls: HTMLElement | null = null;
	private actions: HTMLElement | null = null;

	constructor(private readonly plugin: DaylioBackupImportPlugin, backup?: Backup) {
		super(plugin.app);
		this.backup = backup ?? null;
		this.folder = plugin.settings.folder;
		const s = plugin.settings;
		this.rules = { useRules: s.useRules, nameRule: s.nameRule, filter: { ...s.filter }, dailyMerge: s.dailyMerge, dailyFolder: s.dailyFolder, dailyHeading: s.dailyHeading };
	}
	onOpen(): void {
		this.setTitle(TEXT.title);
		this.modalEl.addClass('daylio-import-modal');
		this.contentEl.addClass('daylio-import');
		this.contentEl.createEl('p', { text: TEXT.description });
		const picker = new Setting(this.contentEl).setName('Daylio backup file').setDesc(TEXT.fileHelp);
		const input = picker.controlEl.createEl('input', { type: 'file', cls: 'daylio-picker' });
		input.setAttribute('aria-label', 'Daylio backup file');
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			if (file) void this.run(async () => {
				this.backup = null;
				this.invalidate();
				if (file.size > MAX_COMPRESSED) throw new Error('The backup exceeds the 20 MiB compressed size limit.');
				this.backup = this.plugin.readBackup(new Uint8Array(await file.arrayBuffer()));
				await this.refreshPreview();
			});
		});
		new Setting(this.contentEl).setName('Import folder').setDesc('Notes go in this folder. Photos go in its attachments folder.')
			.addText((t) => t.setValue(this.folder).onChange((value) => { this.folder = value; this.invalidate(); }));
		this.proControls = this.contentEl.createDiv();
		this.updatePro();
		this.status = this.contentEl.createDiv({ cls: 'daylio-status', attr: { role: 'status', 'aria-live': 'polite' } });
		this.preview = this.contentEl.createDiv({ cls: 'daylio-preview' });
		this.actions = this.contentEl.createDiv({ cls: 'daylio-actions' });
		this.drawActions();
		if (this.backup) void this.run(() => this.refreshPreview());
	}
	private invalidate(): void {
		this.generation++;
		this.plan = null;
		this.preview?.empty();
		if (this.backup) this.message('Select Preview to check the current folder and rules.');
		this.drawActions();
	}
	private message(text: string): void { this.status?.setText(text); }
	private setInputs(disabled: boolean): void {
		this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((input) => { input.disabled = disabled; });
		if (!disabled) this.updatePro();
	}
	private async run(action: () => Promise<void>): Promise<void> {
		if (this.busy || this.disposed) return;
		this.busy = true;
		this.drawActions();
		this.setInputs(true);
		try { await action(); } catch (e) { this.plan = null; this.preview?.empty(); this.message(e instanceof Error ? e.message : String(e)); }
		finally {
			this.busy = false;
			this.token = null;
			if (!this.disposed) { this.setInputs(false); this.drawActions(); }
		}
	}
	/** The options of this window. Pro options are on only when Pro is on. */
	options(): ImportOptions {
		const pro = isPro();
		const r = this.rules;
		return {
			folder: this.folder,
			nameRule: pro && r.useRules ? r.nameRule : DEFAULT_NAME_RULE,
			filter: pro && r.useRules && (r.filter.from || r.filter.to) ? { ...r.filter } : null,
			daily: pro && r.dailyMerge ? { folder: r.dailyFolder, heading: r.dailyHeading } : null,
		};
	}
	async refreshPreview(): Promise<void> {
		if (!this.backup) { this.message('Select a Daylio backup first.'); return; }
		const generation = ++this.generation;
		this.plan = null;
		this.message('Read source IDs and prepare the preview.');
		const plan = await this.plugin.prepare(this.backup, this.options());
		if (this.disposed || generation !== this.generation) return;
		this.plan = plan;
		this.drawPreview(plan);
		this.message('Preview ready. Existing source IDs and file conflicts are skipped.');
		this.drawActions();
	}
	private drawPreview(plan: ImportPlan): void {
		const el = this.preview;
		if (!el) return;
		el.empty();
		const existing = plan.entries.filter((e) => e.existing).length;
		const conflicts = plan.entries.filter((e) => !e.existing && e.conflict);
		const photos = new Set(plan.entries.flatMap((e) => e.photos.map((p) => p.path))).size;
		const parts = [`${plan.entries.length} entries`, `${photos} photos`, `${plan.backup.missing.length} missing photos`, `${plan.backup.unsupported.length} unsupported media`, `${existing} existing IDs`];
		if (plan.filtered) parts.push(`${plan.filtered} outside the date filter`);
		el.createEl('p', { cls: 'daylio-counts', text: parts.join(' · ') });
		const table = el.createEl('table', { cls: 'daylio-table' });
		const header = table.createEl('thead').createEl('tr');
		for (const name of ['ID', 'Local time', 'Mood', 'Activities', 'Photos']) header.createEl('th', { text: name });
		const body = table.createEl('tbody');
		for (const item of plan.entries.slice(0, 8)) {
			const row = body.createEl('tr');
			for (const value of [String(item.entry.id), `${item.entry.date} ${item.entry.time} ${item.entry.offset}`, item.entry.mood || '-', item.entry.activities.join(', ') || '-', String(item.photos.length)]) row.createEl('td', { text: value });
		}
		if (plan.entries.length > 8) el.createEl('p', { text: `The table shows the first 8 of ${plan.entries.length} entries.` });
		this.list(el, 'Missing photos', plan.backup.missing);
		this.list(el, 'Unsupported media', plan.backup.unsupported);
		this.list(el, 'File conflicts', conflicts.map((e) => `Entry ${e.entry.id}: ${e.conflict}`));
		this.list(el, 'Source warnings', plan.backup.warnings);
	}
	private list(el: HTMLElement, title: string, values: string[]): void {
		if (!values.length) return;
		const details = el.createEl('details');
		details.createEl('summary', { text: `${title} (${values.length})` });
		const list = details.createEl('ul');
		for (const value of values.slice(0, 30)) list.createEl('li', { text: value });
		if (values.length > 30) list.createEl('li', { text: `${values.length - 30} more items.` });
	}
	updatePro(): void {
		const el = this.proControls;
		if (!el || this.disposed) return;
		el.empty();
		const pro = isPro();
		const r = this.rules;
		const disabled = !pro || this.busy;
		new Setting(el).setName(TEXT.rules).setHeading();
		new Setting(el).setName('Use the rules below').setDesc('Off: the plugin imports each entry with the name {date} Daylio {id}.')
			.addToggle((t) => t.setValue(pro && r.useRules).setDisabled(this.busy).onChange((value) => {
				// A free user's select shows the Pro notice and sets the toggle back to off. setValue(false) calls this
				// callback again with false; the !pro check returns before any change.
				if (!isPro()) { if (value) { proNotice(NEED_PRO); t.setValue(false); } return; }
				r.useRules = value; this.invalidate();
			}));
		new Setting(el).setName('From date').setDesc(TEXT.fromHelp)
			.addText((t) => t.setPlaceholder('2023-01-01').setValue(r.filter.from).setDisabled(disabled).onChange((value) => { r.filter.from = value.trim(); this.invalidate(); }));
		new Setting(el).setName('To date').setDesc(TEXT.toHelp)
			.addText((t) => t.setPlaceholder('2023-12-31').setValue(r.filter.to).setDisabled(disabled).onChange((value) => { r.filter.to = value.trim(); this.invalidate(); }));
		new Setting(el).setName('File name rule').setDesc('Tokens: {date}, {time}, {id}, {title}, {mood}. The rule must contain {id}.')
			.addText((t) => t.setValue(r.nameRule).setDisabled(disabled).onChange((value) => { r.nameRule = value; this.invalidate(); }));
		new Setting(el).setName(TEXT.daily).setHeading();
		new Setting(el).setName('Merge entries into daily notes').setDesc('Add one line with a link for each entry under the section heading. Other text in the daily note stays.')
			.addToggle((t) => t.setValue(pro && r.dailyMerge).setDisabled(this.busy).onChange((value) => {
				if (!isPro()) { if (value) { proNotice(NEED_PRO); t.setValue(false); } return; }
				r.dailyMerge = value; this.invalidate();
			}));
		new Setting(el).setName('Daily notes folder').setDesc(TEXT.dailyFolderHelp)
			.addText((t) => t.setValue(r.dailyFolder).setDisabled(disabled).onChange((value) => { r.dailyFolder = value; this.invalidate(); }));
		new Setting(el).setName('Section name')
			.addText((t) => t.setValue(r.dailyHeading).setDisabled(disabled).onChange((value) => { r.dailyHeading = value; this.invalidate(); }));
		new Setting(el).addButton((b) => b.setButtonText(TEXT.saveRules).setDisabled(this.busy).onClick(() => {
			// A free user's select shows the Pro notice. No rule is saved.
			if (!isPro()) { proNotice(NEED_PRO); return; }
			void this.run(async () => {
				if (await this.plugin.saveRules({ ...r, filter: { ...r.filter } })) { new Notice('Daylio import rules saved.'); this.message('Rules saved.'); }
			});
		}));
		if (!pro) el.createEl('p', { cls: 'daylio-pro-note', text: proText(TEXT.proNote) });
		this.drawActions();
	}
	private drawActions(): void {
		const el = this.actions;
		if (!el || this.disposed) return;
		el.empty();
		new Setting(el)
			.addButton((b) => b.setButtonText('Preview').setDisabled(this.busy || !this.backup).onClick(() => void this.run(() => this.refreshPreview())))
			.addButton((b) => b.setButtonText('Cancel import').setDisabled(!this.token).onClick(() => { if (this.token) { this.token.cancelled = true; this.message('Stop after the current batch.'); } }))
			.addButton((b) => b.setButtonText('Create notes').setCta().setDisabled(this.busy || !this.plan || !this.plan.entries.length).onClick(() => void this.run(async () => {
				const plan = this.plan;
				if (!plan) return;
				this.token = { cancelled: false };
				this.drawActions();
				this.message('Create notes.');
				const result = await this.plugin.importPlan(plan, this.token);
				this.plan = null;
				if (this.disposed) return;
				this.preview?.empty();
				const stop = result.cancelled ? 'Import stopped. Notes before the stop are in the vault' : 'Import complete';
				this.message(`${stop}: ${result.created} notes created, ${result.skipped} skipped, ${result.photos} photos copied, ${result.merged} daily lines, ${result.errors.length} errors.`);
				if (this.preview) {
					this.list(this.preview, 'Import errors', result.errors);
					this.list(this.preview, 'Missing photos', plan.backup.missing);
					this.list(this.preview, 'Unsupported media', plan.backup.unsupported);
				}
				this.plugin.settings.folder = plan.options.folder;
				await this.plugin.saveSettings();
			})));
	}
	onClose(): void {
		if (this.token) this.token.cancelled = true;
		this.disposed = true;
		this.generation++;
		this.contentEl.empty();
		this.backup = null;
		this.plan = null;
		this.plugin.closed(this);
	}
}

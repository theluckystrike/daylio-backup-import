// Pro through GitHub Sponsors (packages/license, github.ts). product.yaml pro: holds the same values; fx check compares them.
// Every Pro check in the plugin calls isPro(); views redraw through onProChange(). main.ts binds the manager in onload.
import type { SponsorsConfig, SponsorsManager } from './license/index';
import { showProNotice, proNeededText } from './license/github-obsidian';

export const SPONSORS: SponsorsConfig = {
	// Public client id of the seller's OAuth App (device flow on, no client secret anywhere).
	clientId: 'Ov23lic5UPGPZqhBlBGg',
	sponsorLogin: 'theluckystrike',
	minMonthlyUsd: 5,
	oneTimeUsd: 15,
	// 0 = a one-time sponsorship turns Pro on for life.
	oneTimeMonths: 0,
	// Read-only profile access: the sponsorship tier fields need it. No repository or write access.
	scope: 'read:user',
};

export const PRO_UI = {
	proSummary: 'Pro adds a merge of entries into a named daily note section, and saved date filters and file name rules.',
	priceText: 'Sponsor $5 a month, or $15 once. When you have paid $15 in total, Pro stays on.',
};

type Listener = () => void;

let manager: SponsorsManager | null = null;
let unbind: (() => void) | null = null;
const listeners = new Set<Listener>();

/** True when Pro features are on. From the cached GitHub Sponsors answer; never sends a request. */
export function isPro(): boolean {
	return manager?.isPro() ?? false;
}

/** Calls cb each time the Pro state may have changed. Returns a function that removes the listener. */
export function onProChange(cb: Listener): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** Connects the facade to the plugin's GitHub Sponsors manager. */
export function bindPro(pro: SponsorsManager): void {
	unbind?.();
	manager = pro;
	unbind = pro.onChange(() => {
		for (const cb of [...listeners]) cb();
	});
}

/** Disconnects the manager and removes all listeners (plugin unload). */
export function resetPro(): void {
	unbind?.();
	unbind = null;
	manager = null;
	listeners.clear();
}

/** Lead of the Pro gate notices and errors of the import window. */
export const NEED_PRO = 'Date filters, file name rules and the daily note section need Pro.';

/** Shows the shared Pro notice: the lead, then the next step for this user. A free user gets a Sponsor on GitHub button. */
export function proNotice(lead: string): void {
	showProNotice(manager, lead);
}

/** The shared Pro gate text for a view: the lead, then the next step for this user. */
export function proText(lead: string): string {
	return proNeededText(manager, lead);
}

import * as path from 'path';
import * as vscode from 'vscode';

interface BufferQuickPickItem extends vscode.QuickPickItem {
	tab: vscode.Tab;
	uri?: vscode.Uri;
}

let extContext: vscode.ExtensionContext | undefined;
let activePicker: vscode.QuickPick<BufferQuickPickItem> | undefined;
let tabsToClose: vscode.Tab[] = [];
let mruList: string[] = [];

function getTextTabUri(tab: vscode.Tab): vscode.Uri | undefined {
	if (tab.input instanceof vscode.TabInputText) {
		return tab.input.uri;
	}
	return undefined;
}

function getTabId(tab: vscode.Tab): string {
	const uri = getTextTabUri(tab);
	return uri ? uri.toString() : tab.label;
}

function collectOpenTabs(): vscode.Tab[] {
	const tabs: vscode.Tab[] = [];
	const activeGroup = vscode.window.tabGroups.activeTabGroup;
	if (activeGroup) {
		for (const tab of activeGroup.tabs) {
			tabs.push(tab);
		}
	}

	tabs.sort((a, b) => {
		const idA = getTabId(a);
		const idB = getTabId(b);

		const indexA = mruList.indexOf(idA);
		const indexB = mruList.indexOf(idB);

		if (indexA !== -1 && indexB !== -1) {
			return indexA - indexB;
		}

		if (indexA !== -1) { return -1; }
		if (indexB !== -1) { return 1; }

		if (a.isActive && !b.isActive) { return -1; }
		if (!a.isActive && b.isActive) { return 1; }
		return 0;
	});

	return tabs;
}

function tabToQuickPickItem(tab: vscode.Tab): BufferQuickPickItem | undefined {
	const uri = getTextTabUri(tab);
	if (uri) {
		const fileName = path.basename(uri.fsPath);
		const dirName = path.dirname(uri.fsPath);
		return {
			label: fileName,
			detail: uri.fsPath,
			tab,
			uri,
		};
	}

	if (tab.label) {
		return {
			label: tab.label,
			description: tab.group.viewColumn !== undefined ? `Group ${tab.group.viewColumn}` : undefined,
			tab,
		};
	}

	return undefined;
}

async function setPickerContext(active: boolean): Promise<void> {
	await vscode.commands.executeCommand('setContext', 'inTelescopeBufferPicker', active);
}

function disposePicker(): void {
	activePicker?.dispose();
	activePicker = undefined;
}

async function previewTab(item: BufferQuickPickItem): Promise<void> {
	const uri = item.uri ?? getTextTabUri(item.tab);
	if (!uri) {
		return;
	}

	try {
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, {
			preview: true,
			preserveFocus: true,
			viewColumn: item.tab.group.viewColumn,
		});
	} catch {
	}
}

function updateMru(id: string) {
	mruList = mruList.filter((x) => x !== id);
	mruList.unshift(id);
	if (extContext) {
		void extContext.workspaceState.update('telescopeBuffers.mruList', mruList);
	}
}

async function showTabs(): Promise<void> {
	if (activePicker) {
		activePicker.dispose();
	}

	tabsToClose = [];

	const tabspicker = vscode.window.createQuickPick<BufferQuickPickItem>();
	activePicker = tabspicker;

	tabspicker.title = 'Tabs';
	tabspicker.placeholder = 'Search open tabs… (Default: Ctrl+X close · Ctrl+R rename · Ctrl+Enter split · Enter open)';
	tabspicker.matchOnDescription = true;
	tabspicker.matchOnDetail = true;
	tabspicker.ignoreFocusOut = true;

	const tabs = collectOpenTabs();
	tabspicker.items = tabs
		.map(tabToQuickPickItem)
		.filter((item): item is BufferQuickPickItem => item !== undefined);

	if (tabspicker.items.length > 0) {
		tabspicker.activeItems = [tabspicker.items[0]];
	}

	await setPickerContext(true);
	tabspicker.show();

	const subscriptions: vscode.Disposable[] = [];
	let previewTimer: NodeJS.Timeout | undefined;

	subscriptions.push(
		tabspicker.onDidChangeActive((items) => {
			const item = items[0];
			if (!item) { return; }
			if (previewTimer) {
				clearTimeout(previewTimer);
			}
			previewTimer = setTimeout(async () => {
				if (activePicker !== tabspicker) { return; }
				const current = tabspicker.activeItems[0];
				if (current !== item) { return; }
				await previewTab(item);
			}, 120);
		}),
	);

	subscriptions.push(
		tabspicker.onDidAccept(async () => {
			if (previewTimer) {
				clearTimeout(previewTimer);
				previewTimer = undefined;
			}

			const item = tabspicker.activeItems[0];
			let uriToOpen: vscode.Uri | undefined;

			if (item) {
				uriToOpen = item.uri ?? getTextTabUri(item.tab);
			}

			await setPickerContext(false);
			subscriptions.forEach((d) => d.dispose());
			tabspicker.hide();
			disposePicker();

			if (uriToOpen) {
				updateMru(uriToOpen.toString());
				const document = await vscode.workspace.openTextDocument(uriToOpen);
				await vscode.window.showTextDocument(document, {
					preview: false,
					preserveFocus: false,
				});
			}
		}),
	);

	subscriptions.push(
		tabspicker.onDidHide(async () => {
			const activeEd = vscode.window.activeTextEditor;
			if (activeEd && activeEd.document) {
				updateMru(activeEd.document.uri.toString());
			}
			if (previewTimer) {
				clearTimeout(previewTimer);
				previewTimer = undefined;
			}
			await setPickerContext(false);
			subscriptions.forEach((d) => d.dispose());
			if (activePicker === tabspicker) {
				disposePicker();
			}

			if (tabsToClose.length > 0) {
				const tabs = [...tabsToClose];
				tabsToClose = [];
				void Promise.resolve(vscode.window.tabGroups.close(tabs)).catch(() => { });
			}
		}),
	);
}

async function closeActiveTab(): Promise<void> {
	const tabspicker = activePicker;
	if (!tabspicker) {
		return;
	}

	const item = tabspicker.activeItems[0];
	if (!item) {
		return;
	}

	tabsToClose.push(item.tab);

	const closedIndex = tabspicker.items.findIndex((i) => i === item);
	const remainingItems = tabspicker.items.filter((i) => i !== item);
	tabspicker.items = remainingItems;

	if (remainingItems.length === 0) {
		tabspicker.hide();
		return;
	}

	const nextIndex = Math.min(Math.max(closedIndex, 0), remainingItems.length - 1);
	tabspicker.activeItems = [remainingItems[nextIndex]];
}

async function renameActiveTab(): Promise<void> {
	const tabspicker = activePicker;
	if (!tabspicker) {
		return;
	}

	const item = tabspicker.activeItems[0];
	if (!item) {
		return;
	}

	const uri = item.uri ?? getTextTabUri(item.tab);
	if (!uri) {
		void vscode.window.showWarningMessage('Only file tabs can be renamed.');
		return;
	}

	const currentName = path.basename(uri.fsPath);
	const newName = await vscode.window.showInputBox({
		title: 'Rename Tab',
		value: currentName,
		prompt: 'Enter a new file name',
		validateInput: (value) => {
			if (!value.trim()) {
				return 'File name cannot be empty.';
			}
			if (value.includes('/') || value.includes('\\')) {
				return 'Enter a file name only, not a path.';
			}
			return undefined;
		},
	});

	if (!newName || newName === currentName) {
		tabspicker.show();
		return;
	}

	const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(uri.fsPath)), newName);
	const edit = new vscode.WorkspaceEdit();
	edit.renameFile(uri, newUri);

	const success = await vscode.workspace.applyEdit(edit);
	if (!success) {
		tabspicker.show();
		return;
	}

	item.label = newName;
	item.uri = newUri;
	item.detail = newUri.fsPath;

	tabspicker.items = [...tabspicker.items];
	tabspicker.activeItems = [item];
	tabspicker.show();
}

async function openActiveTabToSide(): Promise<void> {
	const tabspicker = activePicker;
	if (!tabspicker) {
		return;
	}

	const item = tabspicker.activeItems[0];
	if (!item) {
		return;
	}

	const uri = item.uri ?? getTextTabUri(item.tab);
	if (uri) {
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, {
			preview: false,
			preserveFocus: false,
			viewColumn: vscode.ViewColumn.Beside,
		});
	}

	tabspicker.hide();
}

export function activate(context: vscode.ExtensionContext): void {
	extContext = context;

	const savedMru = context.workspaceState.get<string[]>('telescopeBuffers.mruList') || [];
	mruList = [...savedMru];

	const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
	if (activeTab) {
		const id = getTabId(activeTab);
		mruList = mruList.filter((x) => x !== id);
		mruList.unshift(id);
	}

	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const id = getTabId(tab);
			if (!mruList.includes(id)) {
				mruList.push(id);
			}
		}
	}

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (activePicker || !editor || !editor.document) { return; }

			const id = editor.document.uri.toString();

			updateMru(id);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tabspicker.show', showTabs),
		vscode.commands.registerCommand('tabspicker.closeActiveTab', closeActiveTab),
		vscode.commands.registerCommand('tabspicker.renameActiveTab', renameActiveTab),
		vscode.commands.registerCommand('tabspicker.openToSide', openActiveTabToSide),
	);
}

export function deactivate(): void {
	void setPickerContext(false);
	disposePicker();
}

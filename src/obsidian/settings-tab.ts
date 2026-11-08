import type { SettingItem } from "../settings/settings-items";

export interface ButtonControl {
	setButtonText(text: string): unknown;
	onClick(listener: () => void): unknown;
}

export interface TextControl {
	setPlaceholder(placeholder: string): unknown;
	setValue(value: string): unknown;
	onChange(listener: (value: string) => void): unknown;
}

export interface ToggleControl {
	setValue(value: boolean): unknown;
	onChange(listener: (value: boolean) => void): unknown;
}

export interface SettingRow {
	setName(name: string): unknown;
	setDesc(description: string): unknown;
	setHeading(): unknown;
	addButton(build: (button: ButtonControl) => unknown): unknown;
	addText(build: (text: TextControl) => unknown): unknown;
	addToggle(build: (toggle: ToggleControl) => unknown): unknown;
}

function renderItem(input: { item: SettingItem; row: SettingRow }): void {
	const { item, row } = input;
	if (item.kind === "heading") {
		row.setName(item.text);
		row.setHeading();
		return;
	}
	row.setName(item.name);
	row.setDesc(item.description);
	if (item.kind === "button") {
		row.addButton((button) => {
			button.setButtonText(item.label);
			button.onClick(item.onClick);
		});
	}
	if (item.kind === "text") {
		row.addText((text) => {
			text.setPlaceholder(item.placeholder);
			text.setValue(item.value);
			text.onChange(item.onChange);
		});
	}
	if (item.kind === "toggle") {
		row.addToggle((toggle) => {
			toggle.setValue(item.value);
			toggle.onChange(item.onChange);
		});
	}
}

export function renderSettings(input: { items: SettingItem[]; addRow: () => SettingRow }): void {
	for (const item of input.items) renderItem({ item, row: input.addRow() });
}

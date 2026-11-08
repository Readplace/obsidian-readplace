import type { SettingItem } from "../settings/settings-items";
import { renderSettings, type SettingRow } from "./settings-tab";

function fakeRows() {
	const rows: Record<string, unknown>[] = [];
	const addRow = (): SettingRow => {
		const row: Record<string, unknown> = {};
		rows.push(row);
		return {
			setName: (name) => (row.name = name),
			setDesc: (description) => (row.description = description),
			setHeading: () => (row.heading = true),
			addButton: (build) =>
				build({
					setButtonText: (text) => (row.label = text),
					onClick: (listener) => (row.click = listener),
				}),
			addText: (build) =>
				build({
					setPlaceholder: (placeholder) => (row.placeholder = placeholder),
					setValue: (value) => (row.textValue = value),
					onChange: (listener) => (row.changeText = listener),
				}),
			addToggle: (build) =>
				build({
					setValue: (value) => (row.toggleValue = value),
					onChange: (listener) => (row.changeToggle = listener),
				}),
		};
	};
	return { rows, addRow };
}

describe("renderSettings", () => {
	it("gives each item its own row, in order", () => {
		const { rows, addRow } = fakeRows();
		const items: SettingItem[] = [
			{ kind: "heading", text: "Account" },
			{ kind: "info", name: "Signed in", description: "Connected." },
		];

		renderSettings({ items, addRow });

		expect(rows).toEqual([
			{ name: "Account", heading: true },
			{ name: "Signed in", description: "Connected." },
		]);
	});

	it("wires a button's label and click", () => {
		const { rows, addRow } = fakeRows();
		const onClick = () => undefined;

		renderSettings({ items: [{ kind: "button", name: "Sync now", description: "Copies.", label: "Sync", onClick }], addRow });

		expect(rows).toEqual([{ name: "Sync now", description: "Copies.", label: "Sync", click: onClick }]);
	});

	it("wires a text field's placeholder, value and change", () => {
		const { rows, addRow } = fakeRows();
		const onChange = (_value: string) => undefined;

		renderSettings({ items: [{ kind: "text", name: "Folder", description: "Where.", value: "Notes", placeholder: "Readplace", onChange }], addRow });

		expect(rows).toEqual([{ name: "Folder", description: "Where.", placeholder: "Readplace", textValue: "Notes", changeText: onChange }]);
	});

	it("wires a toggle's value and change", () => {
		const { rows, addRow } = fakeRows();
		const onChange = (_value: boolean) => undefined;

		renderSettings({ items: [{ kind: "toggle", name: "Sync on open", description: "When.", value: false, onChange }], addRow });

		expect(rows).toEqual([{ name: "Sync on open", description: "When.", toggleValue: false, changeToggle: onChange }]);
	});
});

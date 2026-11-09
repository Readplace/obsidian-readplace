import type { Setting, SettingDefinition, SettingDefinitionItem } from "obsidian";
import type { SettingItem } from "../settings/settings-items";

export type RenderRow = (input: { item: Exclude<SettingItem, { kind: "heading" }>; row: Setting }) => void;

function definitionOf(input: { item: Exclude<SettingItem, { kind: "heading" }>; renderRow: RenderRow }): SettingDefinition {
	const { item, renderRow } = input;
	const base = { name: item.name, desc: item.description, visible: item.visible };
	if (item.kind === "info") return base;
	return { ...base, render: (setting: Setting) => renderRow({ item, row: setting }) };
}

export function buildSettingDefinitions(input: { items: SettingItem[]; renderRow: RenderRow }): SettingDefinitionItem[] {
	const definitions: SettingDefinitionItem[] = [];
	let groupItems: SettingDefinition[] | undefined;
	for (const item of input.items) {
		if (item.kind === "heading") {
			groupItems = [];
			definitions.push({ type: "group", heading: item.text, items: groupItems });
			continue;
		}
		const definition = definitionOf({ item, renderRow: input.renderRow });
		if (groupItems === undefined) definitions.push(definition);
		else groupItems.push(definition);
	}
	return definitions;
}

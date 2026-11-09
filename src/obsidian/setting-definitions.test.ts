import type { Setting, SettingGroup } from "obsidian";
import { assert } from "../assert";
import type { SettingItem } from "../settings/settings-items";
import { buildSettingDefinitions, type RenderRow } from "./setting-definitions";

function recordingRenderRow() {
	const calls: Parameters<RenderRow>[0][] = [];
	const renderRow: RenderRow = (input) => {
		calls.push(input);
	};
	return { calls, renderRow };
}

const hidden = () => false;
const shown = () => true;
const signedIn: SettingItem = { kind: "info", name: "Signed in", description: "Connected.", visible: hidden };
const syncNow: SettingItem = { kind: "button", name: "Sync now", description: "Copies.", visible: shown, label: "Sync", onClick: () => undefined };

describe("buildSettingDefinitions", () => {
	it("opens a group at each heading and puts the following rows in it", () => {
		const definitions = buildSettingDefinitions({
			items: [{ kind: "heading", text: "Account" }, signedIn, { kind: "heading", text: "Sync" }, syncNow],
			renderRow: recordingRenderRow().renderRow,
		});

		expect(definitions).toMatchObject([
			{ type: "group", heading: "Account", items: [{ name: "Signed in", desc: "Connected.", visible: hidden }] },
			{ type: "group", heading: "Sync", items: [{ name: "Sync now", desc: "Copies.", visible: shown }] },
		]);
	});

	it("keeps a row before the first heading at the top level", () => {
		const definitions = buildSettingDefinitions({ items: [syncNow], renderRow: recordingRenderRow().renderRow });

		expect(definitions).toMatchObject([{ name: "Sync now", desc: "Copies.", visible: shown }]);
	});

	it("gives an info row nothing to render", () => {
		const [definition] = buildSettingDefinitions({ items: [signedIn], renderRow: recordingRenderRow().renderRow });

		expect(definition).not.toHaveProperty("render");
	});

	it("renders a row by handing its item and the given setting to the row drawer", () => {
		const { calls, renderRow } = recordingRenderRow();
		const [definition] = buildSettingDefinitions({ items: [syncNow], renderRow });
		const setting = {} as Setting;
		const group = {} as SettingGroup;

		assert(definition !== undefined && "render" in definition && typeof definition.render === "function", "Expected a render row");
		definition.render(setting, group);

		expect(calls).toEqual([{ item: syncNow, row: setting }]);
		expect(calls[0]?.row).toBe(setting);
	});
});

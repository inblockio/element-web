// Parser of kits/rocketchat/CAPABILITIES.md (pure, no DOM): the tables both the overlay and capability-map.spec read.
/** `shown`/`hidden`: on an open room; `user-menu`: rendered only while the user menu is open. */
export type Presence = 'shown' | 'hidden' | 'user-menu';
/** `interim (D16)`: works through a bridge action on Element's own client call; the reason names the view-model it awaits. */
export const INTERIM = 'interim (D16)';
/** The same, for a path that also works through a D20 view-model hook. */
export const INTERIM_D20 = 'interim (D16/D20)';
/** `hand-off (D26)`: Element's view-models feed the function, and the action itself runs in another app (aqua-meet's call window). Treated like wired: no N/A overlay. */
export const HAND_OFF = 'hand-off (D26)';
export type Status = 'wired' | typeof INTERIM | typeof INTERIM_D20 | typeof HAND_OFF | 'N/A';
export type Capability = { id: string; selector: string; presence: Presence; status: Status; reason: string };

const COLUMNS = ['id', 'selector', 'presence', 'status', 'reason'];

const cells = (line: string): string[] =>
	line
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((cell) => cell.trim());

export const parseCapabilities = (markdown: string): Capability[] => {
	const lines = markdown.split('\n');
	const header = lines.findIndex((line) => line.trim().startsWith('|') && cells(line).join() === COLUMNS.join());
	if (header < 0) throw new Error(`capabilities: no table with columns ${COLUMNS.join(', ')}`);
	const rows: Capability[] = [];
	for (const line of lines.slice(header + 2)) {
		if (!line.trim().startsWith('|')) break;
		const [id, rawSelector, presence, status, reason] = cells(line);
		const selector = /^`.+`$/.test(rawSelector) ? rawSelector.slice(1, -1) : '';
		if (!id || !selector) throw new Error(`capabilities: row "${line.trim()}" needs an id and a backticked selector`);
		if (presence !== 'shown' && presence !== 'hidden' && presence !== 'user-menu') throw new Error(`capabilities: ${id}: presence "${presence}"`);
		if (status !== 'wired' && status !== INTERIM && status !== INTERIM_D20 && status !== HAND_OFF && status !== 'N/A') throw new Error(`capabilities: ${id}: status "${status}"`);
		if (status === 'N/A' && !reason) throw new Error(`capabilities: ${id}: an N/A row needs a reason`);
		if (status === HAND_OFF && !reason) throw new Error(`capabilities: ${id}: a ${status} row needs a reason (the view-models and the app the action runs in)`);
		if ((status === INTERIM || status === INTERIM_D20) && !/await/i.test(reason)) throw new Error(`capabilities: ${id}: an ${status} row's reason names the view-model it awaits ("awaits ...")`);
		if (rows.some((row) => row.id === id)) throw new Error(`capabilities: duplicate id ${id}`);
		rows.push({ id, selector, presence, status, reason });
	}
	if (!rows.length) throw new Error('capabilities: empty table');
	return rows;
};

export type UnansweredCall = { call: string; row: string; reason: string };

const CALL_COLUMNS = ['call', 'row', 'reason'];

/**
 * The second table: each call the adapter rejects and records (`window.__clientViewStubLog` names) maps to the N/A row
 * that explains it, or to `none` with the reason its rejection renders nothing. With `rows`, a row id must exist and be N/A.
 */
export const parseUnansweredCalls = (markdown: string, rows?: Capability[]): UnansweredCall[] => {
	const lines = markdown.split('\n');
	const header = lines.findIndex((line) => line.trim().startsWith('|') && cells(line).join() === CALL_COLUMNS.join());
	if (header < 0) throw new Error(`unanswered calls: no table with columns ${CALL_COLUMNS.join(', ')}`);
	const calls: UnansweredCall[] = [];
	for (const line of lines.slice(header + 2)) {
		if (!line.trim().startsWith('|')) break;
		const [rawCall, row, reason] = cells(line);
		const call = /^`.+`$/.test(rawCall) ? rawCall.slice(1, -1) : '';
		if (!call || !row || !reason) throw new Error(`unanswered calls: row "${line.trim()}" needs a backticked call, a row and a reason`);
		if (calls.some((c) => c.call === call)) throw new Error(`unanswered calls: duplicate call ${call}`);
		if (rows && row !== 'none') {
			const target = rows.find((r) => r.id === row);
			if (!target) throw new Error(`unanswered calls: ${call}: row ${row} is not in the capability table`);
			if (target.status !== 'N/A') throw new Error(`unanswered calls: ${call}: row ${row} is not N/A`);
		}
		calls.push({ call, row, reason });
	}
	if (!calls.length) throw new Error('unanswered calls: empty table');
	return calls;
};

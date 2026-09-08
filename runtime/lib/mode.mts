export const MODES = ["auto", "full", "review"] as const;
export type Mode = (typeof MODES)[number];

export type ModeResult =
	| { readonly mode: Mode; readonly unrecognised: null }
	| { readonly mode: "auto"; readonly unrecognised: string };

export function resolveMode(raw: string | undefined): ModeResult {
	switch (raw) {
		case undefined:
		case "":
		case "auto":
			return { mode: "auto", unrecognised: null };
		case "full":
			return { mode: "full", unrecognised: null };
		case "review":
			return { mode: "review", unrecognised: null };
		default:
			return { mode: "auto", unrecognised: raw };
	}
}

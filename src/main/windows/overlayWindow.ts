import { BrowserWindow, screen } from "electron";
import type { SettingsStore } from "../settings/SettingsStore";
import { isMac } from "../platform";
import { isAppUrl, loadRenderer, secureWebPreferences } from "./load";

const DEFAULT_SIZE = { width: 460, height: 340 };

function initialBounds(settings: SettingsStore): Electron.Rectangle {
	const saved = settings.get().overlay.bounds;
	if (saved) {
		// Only reuse saved bounds if they are still visible on some display.
		const visible = screen
			.getAllDisplays()
			.some(
				({ workArea: a }) =>
					saved.x < a.x + a.width &&
					saved.x + saved.width > a.x &&
					saved.y < a.y + a.height &&
					saved.y + saved.height > a.y,
			);
		if (visible) return saved;
	}
	const { workArea } = screen.getPrimaryDisplay();
	return {
		x: workArea.x + workArea.width - DEFAULT_SIZE.width - 24,
		y: workArea.y + 24,
		...DEFAULT_SIZE,
	};
}

/** Frameless, always-on-top answer overlay (FR-O1). */
export function createOverlayWindow(settings: SettingsStore): BrowserWindow {
	const win = new BrowserWindow({
		...initialBounds(settings),
		minWidth: 260,
		minHeight: 140,
		frame: false,
		resizable: true,
		alwaysOnTop: true,
		skipTaskbar: true,
		show: false,
		backgroundColor: "#00000000",
		transparent: true,
		hasShadow: false,
		webPreferences: secureWebPreferences(),
	});

	// win.setContentProtection(true);

	if (isMac) {
		// "floating" sits below full-screen apps on macOS; follow the user across Spaces and full screen.
		win.setAlwaysOnTop(true, "screen-saver");
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	} else {
		win.setAlwaysOnTop(true, "floating", 1);
	}
	win.setOpacity(settings.get().overlay.opacity);
	win.once("ready-to-show", () => {
		win.showInactive();
		setTimeout(() => {
			if (!win.isDestroyed()) {
				//win.setContentProtection(true);
				win.setOpacity(settings.get().overlay.opacity);
			}
		}, 100);
	});
	// Re-apply protection whenever the overlay is toggled or restored
	// win.on("show", () => {
	// 	if (!win.isDestroyed()) win.setContentProtection(true);
	// });
	// win.on("restore", () => {
	// 	if (!win.isDestroyed()) win.setContentProtection(true);
	// });
	win.webContents.on("will-navigate", (e, url) => {
		if (!isAppUrl(url)) e.preventDefault();
	});
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

	let saveTimer: NodeJS.Timeout | null = null;
	const persist = () => {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			if (win.isDestroyed()) return;
			settings.update({ overlay: { bounds: win.getBounds() } });
		}, 500);
	};
	win.on("moved", persist);
	win.on("resized", persist);

	settings.on("changed", (s) => {
		if (!win.isDestroyed()) win.setOpacity(s.overlay.opacity);
	});

	void loadRenderer(win, "overlay");
	return win;
}

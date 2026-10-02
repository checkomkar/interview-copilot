import { BrowserWindow, shell } from "electron";
import { isAppUrl, loadRenderer, secureWebPreferences } from "./load";

export function createMainWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1100,
		height: 760,
		minWidth: 820,
		minHeight: 560,
		title: "Cue",
		backgroundColor: "#0b0d12",
		show: false,
		skipTaskbar: true,
		autoHideMenuBar: true,
		webPreferences: secureWebPreferences(),
	});

	// win.setContentProtection(true);

	win.once("ready-to-show", () => {
		win.show();
		setTimeout(() => {
			if (!win.isDestroyed()) win.setContentProtection(true);
		}, 100);
	});
	// Re-apply protection whenever the main window is opened or un-minimized
	// win.on("show", () => {
	// 	if (!win.isDestroyed()) win.setContentProtection(true);
	// });
	// win.on("restore", () => {
	// 	if (!win.isDestroyed()) win.setContentProtection(true);
	// });
	// Never navigate the app window away; open external links in the browser.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (e, url) => {
		if (!isAppUrl(url)) e.preventDefault();
	});
	void loadRenderer(win, "main");
	return win;
}
